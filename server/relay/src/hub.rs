//! 在线连接注册、路由与离线信箱（Stage 5：可插拔持久化）。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Duration;
use tokio::sync::mpsc::UnboundedSender;

use crate::mailbox::{MailboxStore, MemoryMailbox, StoredFrame};
use crate::protocol::parse_mux_frame;

#[derive(Debug, Clone)]
pub struct HubConfig {
    pub mailbox_max_per_user: usize,
    pub mailbox_ttl: Duration,
}

impl Default for HubConfig {
    fn default() -> Self {
        Self {
            mailbox_max_per_user: 100,
            mailbox_ttl: Duration::from_secs(3600),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RouteResult {
    Delivered(usize),
    Queued,
    Full,
    Invalid,
}

#[derive(Default)]
struct Inner {
    next_conn_id: u64,
    online: HashMap<String, Vec<(u64, UnboundedSender<Vec<u8>>)>>,
    public_keys: HashMap<String, String>,
    services: HashMap<String, Vec<String>>,
}

#[derive(Clone)]
pub struct Hub {
    config: HubConfig,
    inner: std::sync::Arc<Mutex<Inner>>,
    mailbox: std::sync::Arc<dyn MailboxStore>,
}

impl Hub {
    pub fn new(config: HubConfig) -> Self {
        Self::with_mailbox(config, std::sync::Arc::new(MemoryMailbox::default()))
    }

    pub fn with_mailbox(config: HubConfig, mailbox: std::sync::Arc<dyn MailboxStore>) -> Self {
        Self {
            config,
            inner: std::sync::Arc::new(Mutex::new(Inner::default())),
            mailbox,
        }
    }

    /// 注册连接；返回连接 id，并把该用户积压的离线帧立即灌入通道。
    pub fn register(&self, user_id: &str, tx: UnboundedSender<Vec<u8>>) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        let conn_id = inner.next_conn_id;
        inner.next_conn_id += 1;
        inner
            .online
            .entry(user_id.to_string())
            .or_default()
            .push((conn_id, tx.clone()));

        drop(inner);
        for frame in self.mailbox.take(user_id, self.config.mailbox_ttl) {
            let _ = tx.send(frame);
        }

        conn_id
    }

    pub fn set_public_key(&self, user_id: &str, public_key: &str) {
        self.inner
            .lock()
            .unwrap()
            .public_keys
            .insert(user_id.to_string(), public_key.to_string());
    }

    pub fn lookup_public_key(&self, user_id: &str) -> Option<String> {
        self.inner.lock().unwrap().public_keys.get(user_id).cloned()
    }

    pub fn set_services(&self, user_id: &str, app_ids: Vec<String>) {
        self.inner
            .lock()
            .unwrap()
            .services
            .insert(user_id.to_string(), app_ids);
    }

    pub fn lookup_service(&self, app_id: &str) -> Vec<String> {
        self.inner
            .lock()
            .unwrap()
            .services
            .iter()
            .filter(|(_, apps)| apps.iter().any(|app| app == app_id))
            .map(|(user, _)| user.clone())
            .collect()
    }

    pub fn unregister(&self, user_id: &str, conn_id: u64) {
        let mut inner = self.inner.lock().unwrap();
        if let Some(list) = inner.online.get_mut(user_id) {
            list.retain(|(id, _)| *id != conn_id);
            if list.is_empty() {
                inner.online.remove(user_id);
                inner.services.remove(user_id);
            }
        }
    }

    pub fn online_count(&self, user_id: &str) -> usize {
        self.inner
            .lock()
            .unwrap()
            .online
            .get(user_id)
            .map(|list| list.len())
            .unwrap_or(0)
    }

    /// 路由一个浏览器 mux 帧；`sender` 必须是连接建立的 userId。
    pub fn route(&self, sender: &str, bytes: &[u8]) -> RouteResult {
        let Ok(frame) = parse_mux_frame(bytes) else {
            return RouteResult::Invalid;
        };
        if frame.from != sender || frame.to.is_empty() {
            return RouteResult::Invalid;
        }

        let inner = self.inner.lock().unwrap();
        if let Some(targets) = inner.online.get(frame.to) {
            if !targets.is_empty() {
                let mut delivered = 0;
                for (_, tx) in targets {
                    if tx.send(bytes.to_vec()).is_ok() {
                        delivered += 1;
                    }
                }
                if delivered > 0 {
                    return RouteResult::Delivered(delivered);
                }
            }
        }

        drop(inner);
        if self.mailbox.push(
            frame.to,
            StoredFrame {
                bytes: bytes.to_vec(),
                at: std::time::SystemTime::now(),
            },
            self.config.mailbox_max_per_user,
            self.config.mailbox_ttl,
        ) {
            RouteResult::Queued
        } else {
            RouteResult::Full
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::tests::encode_mux_for_test;

    fn frame(from: &str, to: &str) -> Vec<u8> {
        encode_mux_for_test(from, to, &[9, 9])
    }

    #[test]
    fn routes_to_online_connection() {
        let hub = Hub::new(HubConfig::default());
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        hub.register("bob", tx);
        assert_eq!(
            hub.route("alice", &frame("alice", "bob")),
            RouteResult::Delivered(1)
        );
        assert_eq!(rx.try_recv().unwrap(), frame("alice", "bob"));
    }

    #[test]
    fn queues_and_flushes_offline_messages() {
        let hub = Hub::new(HubConfig::default());
        assert_eq!(
            hub.route("alice", &frame("alice", "bob")),
            RouteResult::Queued
        );
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        hub.register("bob", tx);
        assert_eq!(rx.try_recv().unwrap(), frame("alice", "bob"));
    }

    #[test]
    fn rejects_spoofed_sender() {
        let hub = Hub::new(HubConfig::default());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        hub.register("bob", tx);
        assert_eq!(
            hub.route("alice", &frame("carol", "bob")),
            RouteResult::Invalid
        );
    }

    #[test]
    fn unregister_removes_connection() {
        let hub = Hub::new(HubConfig::default());
        let (tx, _rx) = tokio::sync::mpsc::unbounded_channel();
        let id = hub.register("bob", tx);
        assert_eq!(hub.online_count("bob"), 1);
        hub.unregister("bob", id);
        assert_eq!(hub.online_count("bob"), 0);
    }
}
