/// 流量统计模块
/// 使用 tokio::sync::RwLock（读多写少）替代 std::sync::Mutex，避免阻塞 async 任务和 panic 污染。

use std::collections::{HashMap, VecDeque};
use serde::Serialize;
use crate::db;
use crate::protocol;

#[derive(Debug, Clone, Serialize)]
pub struct SessionTraffic {
    pub conn_key: String,
    pub user_id: String,
    pub session_id: String,
    pub username: String,
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
    pub handshake_bytes: u64,
    pub created_at: u64,
    pub last_activity_at: u64,
}

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

#[derive(Debug, Clone, Serialize, Default)]
pub struct GlobalTraffic {
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
    pub handshake_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct MinuteBucket {
    pub minute_epoch: u64,
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct TrafficStatsResponse {
    pub global: GlobalTraffic,
    pub users: Vec<UserTrafficSummary>,
    pub time_distribution: Vec<MinuteBucket>,
    pub user_count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct UserRelayQuota {
    pub user_id: String,
    pub quota_bytes: u64,
    pub used_bytes: u64,
    pub updated_at: u64,
}

pub struct TrafficStats {
    pub sessions: HashMap<String, SessionTraffic>,
    pub minute_buckets: VecDeque<MinuteBucket>,
    pub global: GlobalTraffic,
    current_minute_epoch: u64,
    minute_window: usize,
}

impl TrafficStats {
    pub fn new(minute_window: usize) -> Self {
        Self {
            sessions: HashMap::new(),
            minute_buckets: VecDeque::with_capacity(minute_window),
            global: GlobalTraffic::default(),
            current_minute_epoch: 0,
            minute_window,
        }
    }

    pub fn register_session(&mut self, conn_key: &str, user_id: &str, session_id: &str, username: &str, now_ms: u64) {
        self.sessions.entry(conn_key.to_string()).or_insert(SessionTraffic {
            conn_key: conn_key.to_string(),
            user_id: user_id.to_string(),
            session_id: session_id.to_string(),
            username: username.to_string(),
            inbound_bytes: 0, outbound_bytes: 0, relay_forwarded_bytes: 0, handshake_bytes: 0,
            created_at: now_ms, last_activity_at: now_ms,
        });
    }

    pub fn remove_session(&mut self, conn_key: &str) -> Option<SessionTraffic> {
        self.sessions.remove(conn_key)
    }

    pub fn add_inbound(&mut self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, bytes, 0, 0);
        self.global.inbound_bytes = self.global.inbound_bytes.saturating_add(bytes);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.inbound_bytes = s.inbound_bytes.saturating_add(bytes);
            s.last_activity_at = now_ms;
        }
    }

    pub fn add_outbound(&mut self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, 0, bytes, 0);
        self.global.outbound_bytes = self.global.outbound_bytes.saturating_add(bytes);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.outbound_bytes = s.outbound_bytes.saturating_add(bytes);
            s.last_activity_at = now_ms;
        }
    }

    pub fn add_relay_forwarded(&mut self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, 0, 0, bytes);
        self.global.relay_forwarded_bytes = self.global.relay_forwarded_bytes.saturating_add(bytes);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.relay_forwarded_bytes = s.relay_forwarded_bytes.saturating_add(bytes);
            s.last_activity_at = now_ms;
        }
    }

    pub fn add_handshake(&mut self, conn_key: &str, bytes: u64, _now_ms: u64) {
        self.global.handshake_bytes = self.global.handshake_bytes.saturating_add(bytes);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.handshake_bytes = s.handshake_bytes.saturating_add(bytes);
        }
    }

    fn update_minute_bucket(&mut self, now_ms: u64, inbound: u64, outbound: u64, relay: u64) {
        let minute_epoch = now_ms / 60_000;
        if minute_epoch != self.current_minute_epoch {
            if let Some(last) = self.minute_buckets.back() {
                for m in (last.minute_epoch + 1)..minute_epoch {
                    if self.minute_buckets.len() >= self.minute_window {
                        self.minute_buckets.pop_front();
                    }
                    self.minute_buckets.push_back(MinuteBucket { minute_epoch: m, inbound_bytes: 0, outbound_bytes: 0, relay_forwarded_bytes: 0 });
                }
            }
            self.current_minute_epoch = minute_epoch;
        }
        if let Some(bucket) = self.minute_buckets.iter_mut().rev().find(|b| b.minute_epoch == minute_epoch) {
            bucket.inbound_bytes = bucket.inbound_bytes.saturating_add(inbound);
            bucket.outbound_bytes = bucket.outbound_bytes.saturating_add(outbound);
            bucket.relay_forwarded_bytes = bucket.relay_forwarded_bytes.saturating_add(relay);
        } else {
            if self.minute_buckets.len() >= self.minute_window {
                self.minute_buckets.pop_front();
            }
            self.minute_buckets.push_back(MinuteBucket { minute_epoch, inbound_bytes: inbound, outbound_bytes: outbound, relay_forwarded_bytes: relay });
        }
    }

    pub fn compute_global(&self) -> GlobalTraffic {
        self.global.clone()
    }

    pub fn compute_user_summaries(&self) -> Vec<UserTrafficSummary> {
        let mut user_map: HashMap<String, UserTrafficSummary> = HashMap::new();
        for s in self.sessions.values() {
            let entry = user_map.entry(s.user_id.clone()).or_insert(UserTrafficSummary {
                user_id: s.user_id.clone(), username: String::new(), session_count: 0,
                inbound_bytes: 0, outbound_bytes: 0, relay_forwarded_bytes: 0, handshake_bytes: 0,
            });
            entry.username.clone_from(&s.username);
            entry.session_count = entry.session_count.saturating_add(1);
            entry.inbound_bytes = entry.inbound_bytes.saturating_add(s.inbound_bytes);
            entry.outbound_bytes = entry.outbound_bytes.saturating_add(s.outbound_bytes);
            entry.relay_forwarded_bytes = entry.relay_forwarded_bytes.saturating_add(s.relay_forwarded_bytes);
            entry.handshake_bytes = entry.handshake_bytes.saturating_add(s.handshake_bytes);
        }
        let mut users: Vec<UserTrafficSummary> = user_map.into_values().collect();
        users.sort_by_key(|b| std::cmp::Reverse(b.inbound_bytes));
        users
    }

    pub fn get_time_distribution(&self) -> Vec<MinuteBucket> {
        self.minute_buckets.iter().cloned().collect()
    }

    pub fn build_response(&self, limit: Option<usize>) -> TrafficStatsResponse {
        let all_users = self.compute_user_summaries();
        let user_count = all_users.len();
        let users = if let Some(l) = limit { all_users.into_iter().take(l).collect() } else { all_users };
        TrafficStatsResponse { global: self.compute_global(), users, time_distribution: self.get_time_distribution(), user_count }
    }

    /// 构建所有 session 的快照列表（用于持久化到 DB）
    pub fn build_snapshots(&self) -> Vec<db::SessionSnapshot> {
        self.sessions.values().map(|s| db::SessionSnapshot {
            user_id: s.user_id.clone(),
            session_id: s.session_id.clone(),
            username: s.username.clone(),
            inbound_bytes: s.inbound_bytes,
            outbound_bytes: s.outbound_bytes,
            relay_forwarded_bytes: s.relay_forwarded_bytes,
            handshake_bytes: s.handshake_bytes,
        }).collect()
    }
}

// ──── 定时持久化任务 ────

use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{interval, Duration};

/// 启动流量统计定时持久化任务（返回 JoinHandle）
pub fn start_persistence_task(
    traffic: Arc<RwLock<TrafficStats>>,
    db_tx: tokio::sync::mpsc::UnboundedSender<db::DbCmd>,
    flush_interval_secs: u64,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut ticker = interval(Duration::from_secs(flush_interval_secs));
        // 跳过第一次立即触发（让系统先运行一段时间）
        ticker.tick().await;

        loop {
            ticker.tick().await;

            let (snapshots, global) = {
                let tr = traffic.read().await;
                (tr.build_snapshots(), tr.global.clone())
            };

            let now = protocol::now_ms();

            // 异步投递到 DB actor（无锁、无阻塞）
            let _ = db_tx.send(db::DbCmd::SaveGlobalTraffic {
                inbound_bytes: global.inbound_bytes,
                outbound_bytes: global.outbound_bytes,
                relay_forwarded_bytes: global.relay_forwarded_bytes,
                handshake_bytes: global.handshake_bytes,
                updated_at: now,
            });

            if !snapshots.is_empty() {
                let _ = db_tx.send(db::DbCmd::FlushSessions {
                    snapshot: snapshots,
                    recorded_at: now,
                });
            }
        }
    })
}
