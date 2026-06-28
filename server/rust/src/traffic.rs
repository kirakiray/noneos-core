use std::collections::HashMap;
use serde::{Serialize, Deserialize};
use redb::{Database, ReadableTable, TableDefinition, ReadableDatabase};
use std::sync::atomic::{AtomicU64, Ordering};
use dashmap::DashMap;

// ===== Redb 表定义 =====

/// 用户信息表：userId -> bincode(UserRecord)
/// 存储用户基础信息 + 转发额度，握手时写入，所有 session 关闭时更新用量
const USERS: TableDefinition<&str, Vec<u8>> = TableDefinition::new("users");

/// 用户流量时间分布（每30秒聚合）：(ts_30s, from_user, to_user) -> bytes
/// 双路径写入：1) 每30秒定时 flush  2) 用户所有 session 关闭时即时写入
const USER_TRAFFIC_DIST: TableDefinition<(u64, &str, &str), u64> = TableDefinition::new("user_traffic_dist");

/// 全局累计数据：key_name -> cumulative_value
/// key: "total_inbound", "total_outbound", "total_relay"
const GLOBAL_DATA: TableDefinition<&str, u64> = TableDefinition::new("global_data");

/// 全局流量时间分布（每30秒 delta）：ts_30s -> (inbound_delta, outbound_delta, relay_delta)
const GLOBAL_TRAFFIC_DIST: TableDefinition<u64, (u64, u64, u64)> = TableDefinition::new("global_traffic_dist");

/// 系统快照（每30秒）：ts_30s -> (cpu_percent, mem_percent)
const SYSTEM_STATS: TableDefinition<u64, (f64, f64)> = TableDefinition::new("system_stats");

// ===== 全局累计数据 key 常量 =====
const KEY_TOTAL_INBOUND: &str = "total_inbound";
const KEY_TOTAL_OUTBOUND: &str = "total_outbound";
const KEY_TOTAL_RELAY: &str = "total_relay";

// ===== 数据结构 =====

/// 用户记录（合并用户信息 + 转发额度，存储在 redb users 表）
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserRecord {
    pub user_id: String,
    pub username: String,
    pub public_key: String,
    pub first_seen_at: u64,
    pub last_seen_at: u64,
    pub quota_bytes: u64,
    pub used_bytes: u64,
}

/// 分钟级流量桶（用于 get_traffic_stats 响应）
#[derive(Debug, Clone, Serialize)]
pub struct MinuteBucket {
    pub minute_epoch: u64,
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
}

/// 按用户聚合的流量摘要
#[derive(Debug, Clone, Serialize)]
pub struct UserTrafficSummary {
    pub user_id: String,
    pub username: String,
    pub session_count: usize,
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
    pub handshake_bytes: u64,
}

/// 管理员 get_traffic_stats 命令的响应结构
#[derive(Debug, Clone, Serialize)]
pub struct TrafficStatsResponse {
    pub global: GlobalTraffic,
    pub users: Vec<UserTrafficSummary>,
    pub time_distribution: Vec<MinuteBucket>,
    pub user_count: usize,
}

/// 系统统计记录
#[derive(Debug, Clone, Serialize)]
pub struct SystemStatsRecord {
    pub recorded_at: u64,
    pub cpu_usage_percent: f64,
    pub memory_usage_percent: f64,
}

/// 单个 session 的流量计数器
#[derive(Debug, Serialize)]
pub struct SessionTraffic {
    pub conn_key: String,
    pub user_id: String,
    pub session_id: String,
    pub username: String,
    pub inbound_bytes: AtomicU64,
    pub outbound_bytes: AtomicU64,
    pub relay_forwarded_bytes: AtomicU64,
    pub handshake_bytes: AtomicU64,
    pub created_at: u64,
    pub last_activity_at: AtomicU64,
}

impl Clone for SessionTraffic {
    fn clone(&self) -> Self {
        Self {
            conn_key: self.conn_key.clone(),
            user_id: self.user_id.clone(),
            session_id: self.session_id.clone(),
            username: self.username.clone(),
            inbound_bytes: AtomicU64::new(self.inbound_bytes.load(Ordering::Relaxed)),
            outbound_bytes: AtomicU64::new(self.outbound_bytes.load(Ordering::Relaxed)),
            relay_forwarded_bytes: AtomicU64::new(self.relay_forwarded_bytes.load(Ordering::Relaxed)),
            handshake_bytes: AtomicU64::new(self.handshake_bytes.load(Ordering::Relaxed)),
            created_at: self.created_at,
            last_activity_at: AtomicU64::new(self.last_activity_at.load(Ordering::Relaxed)),
        }
    }
}

/// 全局流量汇总（原子版本）
#[derive(Debug, Default)]
pub struct AtomicGlobalTraffic {
    pub inbound_bytes: AtomicU64,
    pub outbound_bytes: AtomicU64,
    pub relay_forwarded_bytes: AtomicU64,
    pub handshake_bytes: AtomicU64,
}

/// 全局流量汇总（纯数据版本，用于序列化）
#[derive(Debug, Clone, Serialize, Default)]
pub struct GlobalTraffic {
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
    pub handshake_bytes: u64,
}

/// 流量统计容器（高性能并发版）
pub struct TrafficStats {
    pub sessions: DashMap<String, SessionTraffic>,
    pub global: AtomicGlobalTraffic,

    // ---- 以下字段用于 30s 周期 flush ----

    /// 当前 30s 窗口内的 delta 累计值
    interval_inbound: AtomicU64,
    interval_outbound: AtomicU64,
    interval_relay: AtomicU64,

    /// 当前 30s 窗口内的用户粒度转发聚合：(from_user, to_user) -> bytes
    /// 使用 DashMap 减少锁竞争
    user_traffic_map: DashMap<(String, String), u64>,

    /// 当前分钟窗口（只用于 in-memory 的 get_traffic_stats）
    /// 这里的队列操作相对低频，可以用 Mutex 保护
    minute_buckets: std::sync::Mutex<std::collections::VecDeque<MinuteBucket>>,
    minute_window: usize,
    current_minute_epoch: AtomicU64,
}

impl TrafficStats {
    pub fn new(minute_window: usize) -> Self {
        Self {
            sessions: DashMap::new(),
            global: AtomicGlobalTraffic::default(),
            interval_inbound: AtomicU64::new(0),
            interval_outbound: AtomicU64::new(0),
            interval_relay: AtomicU64::new(0),
            user_traffic_map: DashMap::new(),
            minute_buckets: std::sync::Mutex::new(std::collections::VecDeque::with_capacity(minute_window)),
            minute_window,
            current_minute_epoch: AtomicU64::new(0),
        }
    }

    pub fn set_global(&self, global: GlobalTraffic) {
        self.global.inbound_bytes.store(global.inbound_bytes, Ordering::Relaxed);
        self.global.outbound_bytes.store(global.outbound_bytes, Ordering::Relaxed);
        self.global.relay_forwarded_bytes.store(global.relay_forwarded_bytes, Ordering::Relaxed);
        self.global.handshake_bytes.store(global.handshake_bytes, Ordering::Relaxed);
    }

    pub fn register_session(
        &self,
        conn_key: &str,
        user_id: &str,
        session_id: &str,
        username: &str,
        now_ms: u64,
    ) {
        self.sessions.insert(conn_key.to_string(), SessionTraffic {
            conn_key: conn_key.to_string(),
            user_id: user_id.to_string(),
            session_id: session_id.to_string(),
            username: username.to_string(),
            inbound_bytes: AtomicU64::new(0),
            outbound_bytes: AtomicU64::new(0),
            relay_forwarded_bytes: AtomicU64::new(0),
            handshake_bytes: AtomicU64::new(0),
            created_at: now_ms,
            last_activity_at: AtomicU64::new(now_ms),
        });
    }

    pub fn remove_session(&self, conn_key: &str) -> Option<SessionTraffic> {
        self.sessions.remove(conn_key).map(|(_, s)| s)
    }

    /// 移除所有 conn_key 以指定前缀开头的 session（用于管理员按 userId 批量踢出）
    /// 返回被移除的 session 数量
    pub fn remove_sessions_by_prefix(&self, prefix: &str) -> usize {
        let mut count = 0;
        self.sessions.retain(|k, _| {
            if k.starts_with(prefix) {
                count += 1;
                false
            } else {
                true
            }
        });
        count
    }

    /// 入站流量：更新 session 计数 + 全局累计 + 区间 delta
    pub fn add_inbound(&self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, bytes, 0, 0);
        self.global.inbound_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.interval_inbound.fetch_add(bytes, Ordering::Relaxed);
        if let Some(s) = self.sessions.get(conn_key) {
            s.inbound_bytes.fetch_add(bytes, Ordering::Relaxed);
            s.last_activity_at.store(now_ms, Ordering::Relaxed);
        }
    }

    /// 出站流量：更新 session 计数 + 全局累计 + 区间 delta
    pub fn add_outbound(&self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, 0, bytes, 0);
        self.global.outbound_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.interval_outbound.fetch_add(bytes, Ordering::Relaxed);
        if let Some(s) = self.sessions.get(conn_key) {
            s.outbound_bytes.fetch_add(bytes, Ordering::Relaxed);
            s.last_activity_at.store(now_ms, Ordering::Relaxed);
        }
    }

    /// 转发流量：更新 session 计数 + 全局累计 + 区间 delta + 用户粒度分布
    pub fn add_relay_forwarded(&self, conn_key: &str, bytes: u64, now_ms: u64, from_user: &str, to_user: &str) {
        self.update_minute_bucket(now_ms, 0, 0, bytes);
        self.global.relay_forwarded_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.interval_relay.fetch_add(bytes, Ordering::Relaxed);

        // 累加到用户粒度转发分布
        let key = (from_user.to_string(), to_user.to_string());
        self.user_traffic_map.entry(key)
            .and_modify(|v| *v = v.saturating_add(bytes))
            .or_insert(bytes);

        if let Some(s) = self.sessions.get(conn_key) {
            s.relay_forwarded_bytes.fetch_add(bytes, Ordering::Relaxed);
            s.last_activity_at.store(now_ms, Ordering::Relaxed);
        }
    }

    pub fn add_handshake(&self, conn_key: &str, bytes: u64, _now_ms: u64) {
        self.global.handshake_bytes.fetch_add(bytes, Ordering::Relaxed);
        if let Some(s) = self.sessions.get(conn_key) {
            s.handshake_bytes.fetch_add(bytes, Ordering::Relaxed);
        }
    }

    /// 更新 in-memory 分钟级桶（供 get_traffic_stats 管理端使用）
    fn update_minute_bucket(&self, now_ms: u64, inbound: u64, outbound: u64, relay: u64) {
        let minute_epoch = now_ms / 60_000;
        let mut current_epoch = self.current_minute_epoch.load(Ordering::Relaxed);
        
        if minute_epoch != current_epoch {
            let mut buckets = self.minute_buckets.lock().unwrap();
            // 双重检查，防止加锁期间已被其他线程更新
            current_epoch = self.current_minute_epoch.load(Ordering::Relaxed);
            if minute_epoch != current_epoch {
                if let Some(last) = buckets.back() {
                    for m in (last.minute_epoch + 1)..minute_epoch {
                        if buckets.len() >= self.minute_window {
                            buckets.pop_front();
                        }
                        buckets.push_back(MinuteBucket {
                            minute_epoch: m,
                            inbound_bytes: 0,
                            outbound_bytes: 0,
                            relay_forwarded_bytes: 0,
                        });
                    }
                }
                self.current_minute_epoch.store(minute_epoch, Ordering::Relaxed);
            }
        }

        let mut buckets = self.minute_buckets.lock().unwrap();
        if let Some(bucket) = buckets.iter_mut().rev().find(|b| b.minute_epoch == minute_epoch) {
            bucket.inbound_bytes = bucket.inbound_bytes.saturating_add(inbound);
            bucket.outbound_bytes = bucket.outbound_bytes.saturating_add(outbound);
            bucket.relay_forwarded_bytes = bucket.relay_forwarded_bytes.saturating_add(relay);
        } else {
            if buckets.len() >= self.minute_window {
                buckets.pop_front();
            }
            buckets.push_back(MinuteBucket {
                minute_epoch,
                inbound_bytes: inbound,
                outbound_bytes: outbound,
                relay_forwarded_bytes: relay,
            });
        }
    }

    /// 提取当前区间 delta 并重置（供 flush 任务调用）
    pub fn take_interval_deltas(&self) -> (u64, u64, u64) {
        (
            self.interval_inbound.swap(0, Ordering::Relaxed),
            self.interval_outbound.swap(0, Ordering::Relaxed),
            self.interval_relay.swap(0, Ordering::Relaxed),
        )
    }

    /// 提取当前用户粒度转发分布并重置（供 flush 任务调用）
    pub fn take_user_traffic_map(&self) -> HashMap<(String, String), u64> {
        let mut map = HashMap::new();
        // DashMap 的 retain 会锁住分段，但在 flush 这种低频任务中可以接受
        self.user_traffic_map.retain(|k, v| {
            map.insert(k.clone(), *v);
            false // 全部移除
        });
        map
    }

    /// 提取指定用户的转发分布条目（用户断开时调用）
    pub fn take_user_relay_entries(&self, user_id: &str) -> Vec<(String, u64)> {
        let mut entries = Vec::new();
        self.user_traffic_map.retain(|(from, to), bytes| {
            if from == user_id {
                entries.push((to.clone(), *bytes));
                false
            } else {
                true
            }
        });
        entries
    }

    pub fn compute_global(&self) -> GlobalTraffic {
        GlobalTraffic {
            inbound_bytes: self.global.inbound_bytes.load(Ordering::Relaxed),
            outbound_bytes: self.global.outbound_bytes.load(Ordering::Relaxed),
            relay_forwarded_bytes: self.global.relay_forwarded_bytes.load(Ordering::Relaxed),
            handshake_bytes: self.global.handshake_bytes.load(Ordering::Relaxed),
        }
    }

    pub fn compute_user_summaries(&self) -> Vec<UserTrafficSummary> {
        let mut user_map: HashMap<String, UserTrafficSummary> = HashMap::new();
        for r in self.sessions.iter() {
            let s = r.value();
            let entry = user_map.entry(s.user_id.clone()).or_insert(UserTrafficSummary {
                user_id: s.user_id.clone(),
                username: String::new(),
                session_count: 0,
                inbound_bytes: 0,
                outbound_bytes: 0,
                relay_forwarded_bytes: 0,
                handshake_bytes: 0,
            });
            entry.username = s.username.clone();
            entry.session_count = entry.session_count.saturating_add(1);
            entry.inbound_bytes = entry.inbound_bytes.saturating_add(s.inbound_bytes.load(Ordering::Relaxed));
            entry.outbound_bytes = entry.outbound_bytes.saturating_add(s.outbound_bytes.load(Ordering::Relaxed));
            entry.relay_forwarded_bytes = entry.relay_forwarded_bytes.saturating_add(s.relay_forwarded_bytes.load(Ordering::Relaxed));
            entry.handshake_bytes = entry.handshake_bytes.saturating_add(s.handshake_bytes.load(Ordering::Relaxed));
        }
        let mut users: Vec<UserTrafficSummary> = user_map.into_values().collect();
        users.sort_by_key(|b| std::cmp::Reverse(b.inbound_bytes));
        users
    }

    pub fn get_time_distribution(&self) -> Vec<MinuteBucket> {
        self.minute_buckets.lock().unwrap().iter().cloned().collect()
    }

    pub fn build_response(&self, limit: Option<usize>) -> TrafficStatsResponse {
        let all_users = self.compute_user_summaries();
        let user_count = all_users.len();
        let users = if let Some(l) = limit {
            all_users.into_iter().take(l).collect()
        } else {
            all_users
        };
        TrafficStatsResponse {
            global: self.compute_global(),
            users,
            time_distribution: self.get_time_distribution(),
            user_count,
        }
    }
}

/// 获取当前时间戳（毫秒）
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// 获取消息字节大小（用于统计）
pub fn message_byte_size(msg: &tungstenite::Message) -> usize {
    match msg {
        tungstenite::Message::Text(s) => s.len(),
        tungstenite::Message::Binary(d) => d.len(),
        tungstenite::Message::Ping(d) | tungstenite::Message::Pong(d) => d.len(),
        tungstenite::Message::Close(_) => 4,
        tungstenite::Message::Frame(_) => 0,
    }
}

// ===== Redb 读写操作 =====

/// 保存或更新用户记录
pub fn save_user(db: &Database, record: &UserRecord) -> Result<(), redb::Error> {
    let write_txn = db.begin_write()?;
    {
        let mut table = write_txn.open_table(USERS)?;
        let encoded = bincode::serialize(record).unwrap_or_default();
        table.insert(record.user_id.as_str(), encoded)?;
    }
    write_txn.commit()?;
    Ok(())
}

/// 从 redb 加载用户记录
pub fn load_user(db: &Database, user_id: &str) -> Result<Option<UserRecord>, redb::Error> {
    let read_txn = db.begin_read()?;
    let table = read_txn.open_table(USERS)?;
    match table.get(user_id)? {
        Some(sl) => {
            let record: UserRecord = bincode::deserialize(&sl.value()).unwrap_or_else(|_| {
                // 反序列化失败时返回默认记录
                UserRecord {
                    user_id: user_id.to_string(),
                    username: String::new(),
                    public_key: String::new(),
                    first_seen_at: 0,
                    last_seen_at: 0,
                    quota_bytes: 0,
                    used_bytes: 0,
                }
            });
            Ok(Some(record))
        }
        None => Ok(None),
    }
}

/// 加载所有用户记录（供 list_all_users 管理命令使用）
pub fn load_all_users(db: &Database) -> Result<Vec<UserRecord>, redb::Error> {
    let read_txn = db.begin_read()?;
    let table = read_txn.open_table(USERS)?;
    let mut users = Vec::new();
    for entry in table.iter()? {
        let (_key, value) = entry?;
        if let Ok(record) = bincode::deserialize::<UserRecord>(&value.value()) {
            users.push(record);
        }
    }
    // 按 last_seen_at 降序排序
    users.sort_by(|a, b| b.last_seen_at.cmp(&a.last_seen_at));
    Ok(users)
}

/// 加载全局累计数据（启动时调用）
pub fn load_global_data(db: &Database) -> GlobalTraffic {
    let read_txn = match db.begin_read() {
        Ok(txn) => txn,
        Err(_) => return GlobalTraffic::default(),
    };
    let table = match read_txn.open_table(GLOBAL_DATA) {
        Ok(t) => t,
        Err(_) => return GlobalTraffic::default(),
    };

    GlobalTraffic {
        inbound_bytes: table.get(KEY_TOTAL_INBOUND).ok().flatten().map(|v| v.value()).unwrap_or(0),
        outbound_bytes: table.get(KEY_TOTAL_OUTBOUND).ok().flatten().map(|v| v.value()).unwrap_or(0),
        relay_forwarded_bytes: table.get(KEY_TOTAL_RELAY).ok().flatten().map(|v| v.value()).unwrap_or(0),
        handshake_bytes: 0,
    }
}

/// 写入单条用户流量分布记录（用户断开时即时写入）
pub fn write_single_user_traffic_entries(
    db: &Database,
    ts_30s: u64,
    from_user: &str,
    entries: &[(String, u64)],
) -> Result<(), redb::Error> {
    if entries.is_empty() {
        return Ok(());
    }
    let write_txn = db.begin_write()?;
    {
        let mut table = write_txn.open_table(USER_TRAFFIC_DIST)?;
        for (to, bytes) in entries {
            let key = (ts_30s, from_user, to.as_str());
            table.insert(key, bytes)?;
        }
    }
    write_txn.commit()?;
    Ok(())
}

/// 写入系统统计快照
pub fn write_system_stats(
    db: &Database,
    ts_30s: u64,
    cpu_percent: f64,
    mem_percent: f64,
) -> Result<(), redb::Error> {
    let write_txn = db.begin_write()?;
    {
        let mut table = write_txn.open_table(SYSTEM_STATS)?;
        table.insert(ts_30s, (cpu_percent, mem_percent))?;
    }
    write_txn.commit()?;
    Ok(())
}

/// 查询最近的系统统计历史记录
pub fn query_system_stats_history(db: &Database, limit: usize) -> Vec<SystemStatsRecord> {
    let read_txn = match db.begin_read() {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };
    let table = match read_txn.open_table(SYSTEM_STATS) {
        Ok(t) => t,
        Err(_) => return Vec::new(),
    };

    let mut results = Vec::new();
    // 反向遍历获取最近的记录
    for entry in table.iter().ok().into_iter().flat_map(|i| i.rev()) {
        match entry {
            Ok((key, value)) => {
                let (cpu, mem) = value.value();
                results.push(SystemStatsRecord {
                    recorded_at: key.value(),
                    cpu_usage_percent: cpu,
                    memory_usage_percent: mem,
                });
                if results.len() >= limit {
                    break;
                }
            }
            Err(_) => continue,
        }
    }
    results.reverse(); // 按时间升序返回
    results
}

// ===== 持久化后台任务 =====

/// 执行一次完整 flush（由定时器或关闭时调用）
/// 参数都是从 AppState 的快照中提取的
#[allow(clippy::too_many_arguments)]
pub fn perform_flush(
    db: &Database,
    ts_30s: u64,
    inbound_delta: u64,
    outbound_delta: u64,
    relay_delta: u64,
    user_traffic_records: &HashMap<(String, String), u64>,
    global: &GlobalTraffic,
) -> Result<(), redb::Error> {
    let write_txn = db.begin_write()?;
    {
        // 写入用户流量时间分布
        if !user_traffic_records.is_empty() {
            let mut table = write_txn.open_table(USER_TRAFFIC_DIST)?;
            for ((from, to), bytes) in user_traffic_records {
                let key = (ts_30s, from.as_str(), to.as_str());
                table.insert(key, bytes)?;
            }
        }

        // 写入全局流量时间分布（delta），累加而非覆盖，避免同一窗口多次 flush 丢失数据
        if inbound_delta > 0 || outbound_delta > 0 || relay_delta > 0 {
            let mut table = write_txn.open_table(GLOBAL_TRAFFIC_DIST)?;
            let existing = table.get(ts_30s)?.map(|v| v.value()).unwrap_or((0, 0, 0));
            table.insert(ts_30s, (
                existing.0.saturating_add(inbound_delta),
                existing.1.saturating_add(outbound_delta),
                existing.2.saturating_add(relay_delta),
            ))?;
        }

        // 更新全局累计值
        let mut table = write_txn.open_table(GLOBAL_DATA)?;
        table.insert(KEY_TOTAL_INBOUND, &global.inbound_bytes)?;
        table.insert(KEY_TOTAL_OUTBOUND, &global.outbound_bytes)?;
        table.insert(KEY_TOTAL_RELAY, &global.relay_forwarded_bytes)?;
    }
    write_txn.commit()?;
    Ok(())
}

/// 执行关闭时的最终 flush（包含系统指标）
#[allow(dead_code)]
pub fn perform_final_flush(
    db: &Database,
    ts_30s: u64,
    inbound_delta: u64,
    outbound_delta: u64,
    relay_delta: u64,
    user_traffic_records: &HashMap<(String, String), u64>,
    global: &GlobalTraffic,
    cpu_percent: f64,
    mem_percent: f64,
) -> Result<(), redb::Error> {
    let write_txn = db.begin_write()?;
    {
        // 用户流量时间分布
        if !user_traffic_records.is_empty() {
            let mut table = write_txn.open_table(USER_TRAFFIC_DIST)?;
            for ((from, to), bytes) in user_traffic_records {
                let key = (ts_30s, from.as_str(), to.as_str());
                table.insert(key, bytes)?;
            }
        }

        // 全局流量时间分布
        if inbound_delta > 0 || outbound_delta > 0 || relay_delta > 0 {
            let mut table = write_txn.open_table(GLOBAL_TRAFFIC_DIST)?;
            table.insert(ts_30s, (inbound_delta, outbound_delta, relay_delta))?;
        }

        // 全局累计
        {
            let mut table = write_txn.open_table(GLOBAL_DATA)?;
            table.insert(KEY_TOTAL_INBOUND, &global.inbound_bytes)?;
            table.insert(KEY_TOTAL_OUTBOUND, &global.outbound_bytes)?;
            table.insert(KEY_TOTAL_RELAY, &global.relay_forwarded_bytes)?;
        }

        // 系统快照
        {
            let mut table = write_txn.open_table(SYSTEM_STATS)?;
            table.insert(ts_30s, (cpu_percent, mem_percent))?;
        }
    }
    write_txn.commit()?;
    Ok(())
}
