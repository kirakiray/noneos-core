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
/// key: "total_inbound", "total_outbound", "total_relay",
///      "period_inbound", "period_outbound", "period_start"
const GLOBAL_DATA: TableDefinition<&str, u64> = TableDefinition::new("global_data");

/// 全局流量时间分布（每30秒 delta）：ts_30s -> (inbound_delta, outbound_delta, relay_delta)
const GLOBAL_TRAFFIC_DIST: TableDefinition<u64, (u64, u64, u64)> = TableDefinition::new("global_traffic_dist");

/// 系统快照（每30秒）：ts_30s -> (cpu_percent, mem_percent)
const SYSTEM_STATS: TableDefinition<u64, (f64, f64)> = TableDefinition::new("system_stats");

// ===== 全局累计数据 key 常量 =====
const KEY_TOTAL_INBOUND: &str = "total_inbound";
const KEY_TOTAL_OUTBOUND: &str = "total_outbound";
const KEY_TOTAL_RELAY: &str = "total_relay";
/// 当前计费周期内的入站累计字节数
const KEY_PERIOD_INBOUND: &str = "period_inbound";
/// 当前计费周期内的出站累计字节数
const KEY_PERIOD_OUTBOUND: &str = "period_outbound";
/// 当前计费周期的起始时间戳（毫秒），用于判断是否已进入新周期
const KEY_PERIOD_START: &str = "period_start";

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

/// 当前计费周期的服务器整体流量用量
/// 统计口径为 inbound + outbound，贴近服务器真实带宽账单
#[derive(Debug, Clone, Serialize, Default)]
pub struct PeriodUsage {
    /// 周期内入站累计字节数
    pub inbound_bytes: u64,
    /// 周期内出站累计字节数
    pub outbound_bytes: u64,
    /// 周期起始时间戳（毫秒）
    pub period_start_ms: u64,
}

impl PeriodUsage {
    /// 周期内合计用量（inbound + outbound）
    pub fn total_bytes(&self) -> u64 {
        self.inbound_bytes.saturating_add(self.outbound_bytes)
    }
}

/// 计费周期用量（原子版本）
#[derive(Debug, Default)]
pub struct AtomicPeriodUsage {
    pub inbound_bytes: AtomicU64,
    pub outbound_bytes: AtomicU64,
    pub period_start_ms: AtomicU64,
}

/// 流量统计容器（高性能并发版）
pub struct TrafficStats {
    pub sessions: DashMap<String, SessionTraffic>,
    pub global: AtomicGlobalTraffic,
    /// 当前计费周期的服务器整体用量，用于 global_relay_quota_bytes 限额判定
    pub period: AtomicPeriodUsage,

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
            period: AtomicPeriodUsage::default(),
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

    /// 写入计费周期用量（启动时从 redb 恢复）
    pub fn set_period(&self, period: PeriodUsage) {
        self.period.inbound_bytes.store(period.inbound_bytes, Ordering::Relaxed);
        self.period.outbound_bytes.store(period.outbound_bytes, Ordering::Relaxed);
        self.period.period_start_ms.store(period.period_start_ms, Ordering::Relaxed);
    }

    /// 读取当前计费周期用量快照
    pub fn compute_period(&self) -> PeriodUsage {
        PeriodUsage {
            inbound_bytes: self.period.inbound_bytes.load(Ordering::Relaxed),
            outbound_bytes: self.period.outbound_bytes.load(Ordering::Relaxed),
            period_start_ms: self.period.period_start_ms.load(Ordering::Relaxed),
        }
    }

    /// 当前计费周期已用字节数（inbound + outbound）
    pub fn period_used_bytes(&self) -> u64 {
        self.period.inbound_bytes.load(Ordering::Relaxed)
            .saturating_add(self.period.outbound_bytes.load(Ordering::Relaxed))
    }

    /// 若 now_ms 已进入新的计费周期，则将周期用量归零并把周期起点推进到新周期起始
    /// `reset_day` 来自配置 `quota_period_reset_day`（每月几号重置）
    /// 返回 true 表示本次调用发生了周期切换（由低频 flush 定时器驱动，不在热路径判断）
    pub fn roll_period_if_needed(&self, now_ms: u64, reset_day: u32) -> bool {
        let start = period_start_ms(now_ms, reset_day);
        let current_start = self.period.period_start_ms.load(Ordering::Relaxed);
        if current_start >= start {
            return false;
        }
        self.period.inbound_bytes.store(0, Ordering::Relaxed);
        self.period.outbound_bytes.store(0, Ordering::Relaxed);
        self.period.period_start_ms.store(start, Ordering::Relaxed);
        true
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

    /// 入站流量：更新 session 计数 + 全局累计 + 计费周期用量 + 区间 delta
    pub fn add_inbound(&self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, bytes, 0, 0);
        self.global.inbound_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.period.inbound_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.interval_inbound.fetch_add(bytes, Ordering::Relaxed);
        if let Some(s) = self.sessions.get(conn_key) {
            s.inbound_bytes.fetch_add(bytes, Ordering::Relaxed);
            s.last_activity_at.store(now_ms, Ordering::Relaxed);
        }
    }

    /// 出站流量：更新 session 计数 + 全局累计 + 计费周期用量 + 区间 delta
    pub fn add_outbound(&self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, 0, bytes, 0);
        self.global.outbound_bytes.fetch_add(bytes, Ordering::Relaxed);
        self.period.outbound_bytes.fetch_add(bytes, Ordering::Relaxed);
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
        let mut buckets = self.minute_buckets.lock().unwrap();
        
        // 检查是否需要切换到新的分钟窗口
        let current_epoch = self.current_minute_epoch.load(Ordering::Relaxed);
        if minute_epoch != current_epoch {
            // 填充跳过的空白分钟（如果服务器空闲了几分钟）
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
            // 确保当前分钟的桶存在
            if buckets.len() >= self.minute_window {
                buckets.pop_front();
            }
            buckets.push_back(MinuteBucket {
                minute_epoch,
                inbound_bytes: 0,
                outbound_bytes: 0,
                relay_forwarded_bytes: 0,
            });
            self.current_minute_epoch.store(minute_epoch, Ordering::Relaxed);
        }

        // 累加数据到当前分钟桶（不存在时兜底创建，确保不丢数据）
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

/// 读取服务器本地时区相对 UTC 的偏移秒数（含夏令时）
///
/// 通过 libc 的 `localtime_r` 获取，等价于 `date +%z` 的结果。
/// 失败时回退 0（按 UTC 处理）。
fn local_utc_offset_secs(ts_ms: u64) -> i64 {
    let t = (ts_ms / 1000) as libc::time_t;
    let mut tm: libc::tm = unsafe { std::mem::zeroed() };
    // SAFETY: 传入合法的 time_t 与已零初始化的 tm 结构体；localtime_r 是线程安全版本
    let res = unsafe { libc::localtime_r(&t, &mut tm) };
    if res.is_null() {
        return 0;
    }
    tm.tm_gmtoff as i64
}

/// 由「1970-01-01 起的天数」反推公历年月日
///
/// Howard Hinnant 的 civil_from_days 算法，纯整数运算，无需额外依赖。
fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097; // [0, 146096]
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32; // [1, 12]
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 由公历年月日算出「1970-01-01 起的天数」
///
/// Howard Hinnant 的 days_from_civil 算法，是 `civil_from_days` 的逆运算。
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400; // [0, 399]
    let mp = if m > 2 { m - 3 } else { m + 9 } as i64; // [0, 11]
    let doy = (153 * mp + 2) / 5 + d as i64 - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    era * 146_097 + doe - 719_468
}

/// 指定年月的天数
fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => {
            let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0;
            if leap { 29 } else { 28 }
        }
        _ => 30,
    }
}

/// 计算 `ts_ms` 所处计费周期的起始时间戳（毫秒，UTC 时间轴）
///
/// `reset_day` 为配置的重置日（每月几号，取值 1-31）。归零时刻是
/// **服务器本地时区**当天的 00:00。例如 `reset_day = 15`：
/// - 传入 8 月 20 日 → 返回 8 月 15 日 00:00
/// - 传入 8 月 3 日（还没到本月 15 号）→ 返回 7 月 15 日 00:00
///
/// 若目标月份天数不足（如 `reset_day = 31` 而当月只有 30 天），自动取该月最后一天。
/// 返回值是 UTC 时间轴上的绝对时间戳，可直接与 `now_ms()` 比较。
pub fn period_start_ms(ts_ms: u64, reset_day: u32) -> u64 {
    const MS_PER_DAY: i64 = 86_400_000;
    let reset_day = reset_day.clamp(1, 31);
    let offset_ms = local_utc_offset_secs(ts_ms) * 1000;

    // 换算到本地时间轴，取出当前的年/月/日
    let local_ms = ts_ms as i64 + offset_ms;
    let (year, month, day) = civil_from_days(local_ms.div_euclid(MS_PER_DAY));

    // 本月的实际重置日（天数不足时取当月最后一天）
    let this_month_reset = reset_day.min(days_in_month(year, month));

    // 还没到本月的重置日 → 周期起点在上一个月
    let (py, pm) = if day >= this_month_reset {
        (year, month)
    } else if month == 1 {
        (year - 1, 12)
    } else {
        (year, month - 1)
    };
    let pd = reset_day.min(days_in_month(py, pm));

    let local_start = days_from_civil(py, pm, pd) * MS_PER_DAY;
    // 用周期起点当刻的本地偏移换回 UTC，避免夏令时切换导致偏差
    let approx_utc = local_start - offset_ms;
    let start_offset_ms = local_utc_offset_secs(approx_utc.max(0) as u64) * 1000;
    (local_start - start_offset_ms).max(0) as u64
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

/// 加载计费周期用量（启动时调用）
///
/// 若持久化的周期起点早于当前周期起始（例如服务器跨周期停机），则视为新周期，
/// 返回归零后的用量并把周期起点设为当前周期起始。
pub fn load_period_usage(db: &Database, now_ms_val: u64, reset_day: u32) -> PeriodUsage {
    let start = period_start_ms(now_ms_val, reset_day);
    let fresh = PeriodUsage {
        inbound_bytes: 0,
        outbound_bytes: 0,
        period_start_ms: start,
    };

    let read_txn = match db.begin_read() {
        Ok(txn) => txn,
        Err(_) => return fresh,
    };
    let table = match read_txn.open_table(GLOBAL_DATA) {
        Ok(t) => t,
        Err(_) => return fresh,
    };

    let period_start = table.get(KEY_PERIOD_START).ok().flatten().map(|v| v.value()).unwrap_or(0);
    if period_start < start {
        return fresh;
    }

    PeriodUsage {
        inbound_bytes: table.get(KEY_PERIOD_INBOUND).ok().flatten().map(|v| v.value()).unwrap_or(0),
        outbound_bytes: table.get(KEY_PERIOD_OUTBOUND).ok().flatten().map(|v| v.value()).unwrap_or(0),
        period_start_ms: period_start,
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
    period: &PeriodUsage,
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
        // 更新计费周期用量（用于服务器整体月度限额）
        table.insert(KEY_PERIOD_INBOUND, &period.inbound_bytes)?;
        table.insert(KEY_PERIOD_OUTBOUND, &period.outbound_bytes)?;
        table.insert(KEY_PERIOD_START, &period.period_start_ms)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    /// 由本地时区的年月日 00:00 构造 UTC 毫秒时间戳（测试辅助）
    fn local_ymd_ms(y: i64, m: u32, d: u32) -> u64 {
        let local = days_from_civil(y, m, d) * 86_400_000;
        // 迭代一次以消除偏移带来的误差（时区偏移不超过 1 天）
        let off = local_utc_offset_secs(local.max(0) as u64) * 1000;
        let approx = local - off;
        let off2 = local_utc_offset_secs(approx.max(0) as u64) * 1000;
        (local - off2).max(0) as u64
    }

    #[test]
    fn civil_roundtrip() {
        // days_from_civil 与 civil_from_days 应互为逆运算
        for days in [0_i64, 1, 59, 60, 20_000, 20_667, 30_000] {
            let (y, m, d) = civil_from_days(days);
            assert_eq!(days_from_civil(y, m, d), days, "roundtrip failed at {days}");
        }
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }

    #[test]
    fn days_in_month_leap_years() {
        assert_eq!(days_in_month(2024, 2), 29); // 闰年
        assert_eq!(days_in_month(2025, 2), 28);
        assert_eq!(days_in_month(2000, 2), 29); // 400 整除是闰年
        assert_eq!(days_in_month(1900, 2), 28); // 100 整除但非 400 → 平年
        assert_eq!(days_in_month(2026, 4), 30);
    }

    #[test]
    fn reset_day_1_returns_month_start() {
        // reset_day = 1：周期起点就是当月 1 号
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 8, 20), 1),
            local_ymd_ms(2026, 8, 1)
        );
        // 正好在 1 号当天，起点是当天而非上月
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 8, 1), 1),
            local_ymd_ms(2026, 8, 1)
        );
    }

    #[test]
    fn reset_day_mid_month() {
        // reset_day = 15，已过本月 15 号 → 起点为本月 15 号
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 8, 20), 15),
            local_ymd_ms(2026, 8, 15)
        );
        // 正好是 15 号 → 起点为当天
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 8, 15), 15),
            local_ymd_ms(2026, 8, 15)
        );
        // 还没到本月 15 号 → 起点回退到上月 15 号
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 8, 3), 15),
            local_ymd_ms(2026, 7, 15)
        );
    }

    #[test]
    fn reset_day_crosses_year_boundary() {
        // 1 月还没到重置日 → 回退到上一年 12 月
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 1, 5), 20),
            local_ymd_ms(2025, 12, 20)
        );
    }

    #[test]
    fn reset_day_clamped_to_short_month() {
        // reset_day = 31，但 4 月只有 30 天 → 取 4 月 30 号
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 4, 30), 31),
            local_ymd_ms(2026, 4, 30)
        );
        // 4 月 15 号还没到（4 月的重置日被夹到 30）→ 回退到 3 月 31 号
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 4, 15), 31),
            local_ymd_ms(2026, 3, 31)
        );
        // reset_day = 30，2 月只有 28 天（2026 平年）→ 取 2 月 28 号
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 2, 28), 30),
            local_ymd_ms(2026, 2, 28)
        );
    }

    #[test]
    fn reset_day_out_of_range_is_clamped() {
        // 0 与 99 应被夹到合法区间 [1, 31]，不 panic
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 8, 20), 0),
            period_start_ms(local_ymd_ms(2026, 8, 20), 1)
        );
        assert_eq!(
            period_start_ms(local_ymd_ms(2026, 8, 20), 99),
            period_start_ms(local_ymd_ms(2026, 8, 20), 31)
        );
    }

    #[test]
    fn period_start_is_monotonic_within_period() {
        // 同一周期内任意时刻的起点必须一致
        let a = period_start_ms(local_ymd_ms(2026, 8, 15), 15);
        let b = period_start_ms(local_ymd_ms(2026, 8, 15) + 3_600_000 * 5, 15);
        let c = period_start_ms(local_ymd_ms(2026, 9, 14) + 3_600_000 * 23, 15);
        assert_eq!(a, b);
        assert_eq!(a, c);
        // 跨过下一个重置日后起点前进
        let d = period_start_ms(local_ymd_ms(2026, 9, 15), 15);
        assert!(d > a);
        assert_eq!(d, local_ymd_ms(2026, 9, 15));
    }
}
