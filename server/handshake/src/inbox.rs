//! 离线收件箱（store-and-forward inbox）
//!
//! 目标用户离线时，relay 请求可携带 `store_if_offline` 标记把消息暂存在
//! 服务器；目标用户下次握手成功后，积压消息按存储顺序补投给新会话。
//!
//! 设计要点：
//! - 存储 payload 为「完整转发消息」：文本为 JSON 字节，二进制为完整帧
//!   （[4B header_len][header][payload]），补投时原样下发，接收方无感知；
//! - E2EE 场景下 payload 是密文，服务器无法窥探内容；
//! - 读取即删除（read-and-delete）：积压投递给「最先握手的那个会话」，
//!   不做多次重投，避免重连风暴下的重复投递与带宽浪费（应用层 msgId
//!   去重仍可兜底迟到重复）；
//! - 条目按 TTL 过期惰性清理（读取时丢弃过期项）；
//! - 每用户条目数有上限，超出时拒存（回 `inbox_full`），由客户端回退
//!   本地队列，不做静默淘汰。

use redb::{Database, ReadableTable, TableDefinition};
use serde::{Deserialize, Serialize};

/// 收件箱表：key = (userId, stored_at_ms, seq)，value = bincode(InboxEntry)
/// seq 为进程内单调计数，与毫秒时间戳组合保证同一用户内 key 唯一且有序
const INBOX: TableDefinition<(&str, u64, u64), Vec<u8>> = TableDefinition::new("inbox");

/// 单条收件箱消息
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InboxEntry {
    /// 发送方 userId（补投时作为 from_user_id 原样还原）
    pub from_user_id: String,
    /// 发送方 sessionId
    pub from_session_id: String,
    /// payload 是否为二进制帧（false = 文本 JSON）
    pub is_binary: bool,
    /// 完整转发消息字节（文本 JSON 或二进制帧）
    pub payload: Vec<u8>,
    /// 存储时间（Unix 毫秒），同时作为排序与 TTL 依据
    pub stored_at_ms: u64,
}

/// 进程内单调序号，与 stored_at_ms 组合避免同毫秒 key 冲突
static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

fn next_seq() -> u64 {
    std::sync::atomic::AtomicU64::fetch_add(
        &SEQ,
        1,
        std::sync::atomic::Ordering::Relaxed,
    )
}

/// 存储一条离线消息。
/// 写入前顺带清理该用户已过期（或损坏）的条目，容量只按存活条目计算——
/// 死数据不占坑，避免「过期条目积压导致新消息被拒」的病态。
/// 返回 Ok(true) 表示已存储；Ok(false) 表示该用户收件箱已满（拒存）。
pub fn store(
    db: &Database,
    target_user_id: &str,
    entry: InboxEntry,
    max_per_user: usize,
    ttl_ms: u64,
) -> Result<bool, Box<dyn std::error::Error + Send + Sync>> {
    let now_ms = crate::traffic::now_ms();
    let write_txn = db.begin_write()?;
    let stored;
    {
        let mut table = write_txn.open_table(INBOX)?;
        let start = (target_user_id, 0u64, 0u64);
        let end = (target_user_id, u64::MAX, u64::MAX);
        // 遍历统计存活条数，顺带收集过期/损坏条目（先收集后删，避免迭代中改表）
        let mut live_count = 0usize;
        let mut stale_keys: Vec<(String, u64, u64)> = Vec::new();
        for res in table.range(start..=end)? {
            let (k, v) = res?;
            let (user, ms, seq) = k.value();
            let stale = bincode::deserialize::<InboxEntry>(&v.value())
                .map(|e| e.stored_at_ms.saturating_add(ttl_ms) <= now_ms)
                .unwrap_or(true); // 反序列化失败的损坏条目视为过期清除
            if stale {
                stale_keys.push((user.to_string(), ms, seq));
            } else {
                live_count += 1;
            }
        }
        for (user, ms, seq) in &stale_keys {
            table.remove((user.as_str(), *ms, *seq))?;
        }
        if live_count >= max_per_user {
            stored = false;
        } else {
            let key = (target_user_id, entry.stored_at_ms, next_seq());
            let encoded = bincode::serialize(&entry)?;
            table.insert(key, encoded)?;
            stored = true;
        }
    }
    write_txn.commit()?;
    Ok(stored)
}

/// 全表清扫过期（或损坏）条目，返回删除条数。
/// 由后台定时器周期调用，让 TTL 成为真实的磁盘上界，
/// 而不是仅在目标用户握手读取时才惰性生效（永不回来的用户条目得以清除）。
pub fn sweep_expired(
    db: &Database,
    ttl_ms: u64,
) -> Result<u64, Box<dyn std::error::Error + Send + Sync>> {
    let now_ms = crate::traffic::now_ms();
    let write_txn = db.begin_write()?;
    let removed;
    {
        let mut table = write_txn.open_table(INBOX)?;
        let mut stale_keys: Vec<(String, u64, u64)> = Vec::new();
        for res in table.iter()? {
            let (k, v) = res?;
            let (user, ms, seq) = k.value();
            let stale = bincode::deserialize::<InboxEntry>(&v.value())
                .map(|e| e.stored_at_ms.saturating_add(ttl_ms) <= now_ms)
                .unwrap_or(true);
            if stale {
                stale_keys.push((user.to_string(), ms, seq));
            }
        }
        for (user, ms, seq) in &stale_keys {
            table.remove((user.as_str(), *ms, *seq))?;
        }
        removed = stale_keys.len() as u64;
    }
    write_txn.commit()?;
    Ok(removed)
}

/// 加载并清空某用户的全部收件箱条目（读取即删除）。
/// 过期条目（stored_at_ms + ttl_ms <= now_ms）直接丢弃不投递。
/// 结果按存储顺序（时间 + 序号）排列。
pub fn load_and_clear(
    db: &Database,
    target_user_id: &str,
    ttl_ms: u64,
) -> Result<Vec<InboxEntry>, Box<dyn std::error::Error + Send + Sync>> {
    let now_ms = crate::traffic::now_ms();
    let mut entries = Vec::new();

    let write_txn = db.begin_write()?;
    {
        let mut table = write_txn.open_table(INBOX)?;
        let start = (target_user_id, 0u64, 0u64);
        let end = (target_user_id, u64::MAX, u64::MAX);
        let keys: Vec<(String, u64, u64)> = table
            .range(start..=end)?
            .filter_map(|res| {
                res.ok().map(|(k, _)| {
                    let (user, ms, seq) = k.value();
                    (user.to_string(), ms, seq)
                })
            })
            .collect();
        for (user, ms, seq) in keys {
            if let Some(value) = table.remove((user.as_str(), ms, seq))? {
                if let Ok(entry) = bincode::deserialize::<InboxEntry>(&value.value()) {
                    // TTL 惰性清理：过期条目不投递
                    if entry.stored_at_ms.saturating_add(ttl_ms) > now_ms {
                        entries.push(entry);
                    }
                }
            }
        }
    }
    write_txn.commit()?;
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_db() -> Database {
        let path = std::env::temp_dir().join(format!(
            "noneos-inbox-test-{}-{}.redb",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        Database::create(path).unwrap()
    }

    fn entry(payload: &[u8], stored_at_ms: u64) -> InboxEntry {
        InboxEntry {
            from_user_id: "user-a".into(),
            from_session_id: "s-a1".into(),
            is_binary: false,
            payload: payload.to_vec(),
            stored_at_ms,
        }
    }

    #[test]
    fn store_then_load_and_clear() {
        let db = temp_db();
        let now = crate::traffic::now_ms();
        assert!(store(&db, "user-b", entry(b"m1", now), 10, 10_000).unwrap());
        assert!(store(&db, "user-b", entry(b"m2", now + 1), 10, 10_000).unwrap());

        let got = load_and_clear(&db, "user-b", 10_000).unwrap();
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].payload, b"m1"); // 按存储顺序
        assert_eq!(got[1].payload, b"m2");
        assert_eq!(got[0].from_user_id, "user-a");

        // 读取即删除：再读为空
        let got2 = load_and_clear(&db, "user-b", 10_000).unwrap();
        assert!(got2.is_empty());
    }

    #[test]
    fn max_per_user_rejects_overflow() {
        let db = temp_db();
        let now = crate::traffic::now_ms();
        for i in 0..3 {
            assert!(store(&db, "user-c", entry(format!("m{}", i).as_bytes(), now + i), 3, 10_000).unwrap());
        }
        // 第 4 条拒存
        assert!(!store(&db, "user-c", entry(b"m4", now + 999), 3, 10_000).unwrap());
        // 其他用户不受影响
        assert!(store(&db, "user-d", entry(b"m1", now), 3, 10_000).unwrap());
    }

    #[test]
    fn expired_entries_dropped_on_load() {
        let db = temp_db();
        let now = crate::traffic::now_ms();
        assert!(store(&db, "user-e", entry(b"fresh", now), 10, 30_000).unwrap());
        assert!(store(&db, "user-e", entry(b"stale", now.saturating_sub(60_000)), 10, 30_000).unwrap());

        let got = load_and_clear(&db, "user-e", 30_000).unwrap(); // TTL 30s
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].payload, b"fresh");
    }

    #[test]
    fn store_gcs_expired_and_frees_capacity() {
        // 满箱后过期条目不应占坑：写入时顺带清理，新消息可入箱
        let db = temp_db();
        let now = crate::traffic::now_ms();
        let ttl_ms = 30_000u64;
        for i in 0..3 {
            assert!(store(&db, "user-f", entry(format!("old{}", i).as_bytes(), now.saturating_sub(60_000)), 3, ttl_ms).unwrap());
        }
        // 箱内 3 条全部已过期：新消息应清理死块后成功入箱
        assert!(store(&db, "user-f", entry(b"new", now), 3, ttl_ms).unwrap());
        let got = load_and_clear(&db, "user-f", ttl_ms).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].payload, b"new");
    }

    #[test]
    fn sweep_expired_removes_stale_keeps_live() {
        let db = temp_db();
        let now = crate::traffic::now_ms();
        let ttl_ms = 30_000u64;
        assert!(store(&db, "user-g", entry(b"live", now), 10, ttl_ms).unwrap());
        assert!(store(&db, "user-g", entry(b"stale", now.saturating_sub(60_000)), 10, ttl_ms).unwrap());
        assert!(store(&db, "user-h", entry(b"other-live", now), 10, ttl_ms).unwrap());

        let removed = sweep_expired(&db, ttl_ms).unwrap();
        assert_eq!(removed, 1); // 只清 user-g 的过期条目

        let got = load_and_clear(&db, "user-g", ttl_ms).unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].payload, b"live");
        let got_h = load_and_clear(&db, "user-h", ttl_ms).unwrap();
        assert_eq!(got_h.len(), 1);
        assert_eq!(got_h[0].payload, b"other-live");
    }
}

