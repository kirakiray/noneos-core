//! 离线信箱（Stage 5：内存 / 文件持久化）
use base64::Engine as _;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

#[derive(Clone, Debug)]
pub struct StoredFrame {
    pub bytes: Vec<u8>,
    pub at: SystemTime,
}

pub trait MailboxStore: Send + Sync {
    fn push(&self, user_id: &str, frame: StoredFrame, max: usize, ttl: Duration) -> bool;
    fn take(&self, user_id: &str, ttl: Duration) -> Vec<Vec<u8>>;
}

fn is_expired(frame: &StoredFrame, now: SystemTime, ttl: Duration) -> bool {
    now.duration_since(frame.at)
        .map(|age| age > ttl)
        .unwrap_or(false)
}

#[derive(Default)]
pub struct MemoryMailbox {
    inner: Mutex<HashMap<String, VecDeque<StoredFrame>>>,
}

impl MailboxStore for MemoryMailbox {
    fn push(&self, user_id: &str, frame: StoredFrame, max: usize, ttl: Duration) -> bool {
        let now = SystemTime::now();
        let mut inner = self.inner.lock().unwrap();
        let queue = inner.entry(user_id.to_string()).or_default();
        while queue
            .front()
            .map(|front| is_expired(front, now, ttl))
            .unwrap_or(false)
        {
            queue.pop_front();
        }
        if queue.len() >= max {
            return false;
        }
        queue.push_back(frame);
        true
    }

    fn take(&self, user_id: &str, ttl: Duration) -> Vec<Vec<u8>> {
        let now = SystemTime::now();
        let mut inner = self.inner.lock().unwrap();
        let Some(queue) = inner.remove(user_id) else {
            return Vec::new();
        };
        queue
            .into_iter()
            .filter(|frame| !is_expired(frame, now, ttl))
            .map(|frame| frame.bytes)
            .collect()
    }
}

#[derive(serde::Serialize, serde::Deserialize)]
struct PersistedFrame {
    at_ms: u64,
    data: String,
}

pub struct FileMailbox {
    path: std::path::PathBuf,
    inner: Mutex<HashMap<String, VecDeque<StoredFrame>>>,
}

impl FileMailbox {
    pub fn open(path: impl Into<std::path::PathBuf>) -> Result<Self, String> {
        let path = path.into();
        let mut map = HashMap::new();
        if path.exists() {
            let text = std::fs::read_to_string(&path).map_err(|err| err.to_string())?;
            if !text.trim().is_empty() {
                let stored: HashMap<String, Vec<PersistedFrame>> =
                    serde_json::from_str(&text).map_err(|err| err.to_string())?;
                for (user, frames) in stored {
                    let mut queue = VecDeque::new();
                    for frame in frames {
                        let bytes = base64::engine::general_purpose::STANDARD
                            .decode(frame.data)
                            .map_err(|err| err.to_string())?;
                        queue.push_back(StoredFrame {
                            bytes,
                            at: UNIX_EPOCH + Duration::from_millis(frame.at_ms),
                        });
                    }
                    map.insert(user, queue);
                }
            }
        }
        Ok(Self {
            path,
            inner: Mutex::new(map),
        })
    }

    fn save_locked(&self, map: &HashMap<String, VecDeque<StoredFrame>>) {
        use base64::{engine::general_purpose::STANDARD, Engine as _};
        let stored: HashMap<String, Vec<PersistedFrame>> = map
            .iter()
            .map(|(user, frames)| {
                let frames = frames
                    .iter()
                    .map(|frame| PersistedFrame {
                        at_ms: frame
                            .at
                            .duration_since(UNIX_EPOCH)
                            .map(|d| d.as_millis() as u64)
                            .unwrap_or(0),
                        data: STANDARD.encode(&frame.bytes),
                    })
                    .collect();
                (user.clone(), frames)
            })
            .collect();
        if let Ok(text) = serde_json::to_string(&stored) {
            let tmp = self.path.with_extension("tmp");
            if std::fs::write(&tmp, text).is_ok() {
                let _ = std::fs::rename(tmp, &self.path);
            }
        }
    }
}

impl MailboxStore for FileMailbox {
    fn push(&self, user_id: &str, frame: StoredFrame, max: usize, ttl: Duration) -> bool {
        let now = SystemTime::now();
        let mut inner = self.inner.lock().unwrap();
        let queue = inner.entry(user_id.to_string()).or_default();
        while queue
            .front()
            .map(|front| is_expired(front, now, ttl))
            .unwrap_or(false)
        {
            queue.pop_front();
        }
        if queue.len() >= max {
            return false;
        }
        queue.push_back(frame);
        self.save_locked(&inner);
        true
    }

    fn take(&self, user_id: &str, ttl: Duration) -> Vec<Vec<u8>> {
        let now = SystemTime::now();
        let mut inner = self.inner.lock().unwrap();
        let Some(queue) = inner.remove(user_id) else {
            return Vec::new();
        };
        self.save_locked(&inner);
        queue
            .into_iter()
            .filter(|frame| !is_expired(frame, now, ttl))
            .map(|frame| frame.bytes)
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn memory_mailbox_roundtrip() {
        let mailbox = MemoryMailbox::default();
        assert!(mailbox.push(
            "bob",
            StoredFrame {
                bytes: vec![1],
                at: SystemTime::now()
            },
            10,
            Duration::from_secs(60)
        ));
        assert_eq!(mailbox.take("bob", Duration::from_secs(60)), vec![vec![1]]);
    }

    #[test]
    fn file_mailbox_survives_reopen() {
        let path =
            std::env::temp_dir().join(format!("noneos-relay-mailbox-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        {
            let mailbox = FileMailbox::open(&path).unwrap();
            mailbox.push(
                "bob",
                StoredFrame {
                    bytes: vec![7, 8],
                    at: SystemTime::now(),
                },
                10,
                Duration::from_secs(60),
            );
        }
        let mailbox = FileMailbox::open(&path).unwrap();
        assert_eq!(
            mailbox.take("bob", Duration::from_secs(60)),
            vec![vec![7, 8]]
        );
        let _ = std::fs::remove_file(path);
    }
}
