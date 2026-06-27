/// 全局状态管理
/// 所有并发数据结构使用 DashMap（lock-free）和 tokio::sync::RwLock

use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{oneshot, mpsc, RwLock, Semaphore};
use tungstenite::protocol::Message;
use dashmap::DashMap;

use crate::config::Config;
use crate::traffic::{TrafficStats, UserRelayQuota};
use crate::db;
use crate::protocol;

pub struct UserSession {
    pub username: String,
    pub host: String,
    pub addr: SocketAddr,
    pub disconnect_tx: Option<oneshot::Sender<()>>,
    pub data_tx: mpsc::UnboundedSender<Message>,
    pub latency_ms: Option<u64>,
    pub connected_at: u64,
    pub relay_fail_count: u32,
    pub relay_fail_window_start: u64,
    pub services: Vec<String>,
}

pub struct AppState {
    pub admin_user_id: Option<String>,
    pub config: Config,
    /// 使用 Arc + tokio RwLock，支持跨 task 共享
    pub traffic: Arc<RwLock<TrafficStats>>,
    pub user_quotas: DashMap<String, UserRelayQuota>,
    pub users: DashMap<String, UserSession>,
    pub user_session_counts: DashMap<String, usize>,
    /// 关注者映射
    pub watchers: DashMap<String, DashMap<String, mpsc::UnboundedSender<Message>>>,
    pub watch_targets: DashMap<String, Vec<String>>,
    /// DB actor 发送通道
    pub db: Option<mpsc::UnboundedSender<db::DbCmd>>,
    /// 全局连接信号量
    pub conn_semaphore: Arc<Semaphore>,
}

impl AppState {
    pub fn new(
        admin_user_id: Option<String>,
        config: Config,
        db_tx: Option<mpsc::UnboundedSender<db::DbCmd>>,
    ) -> Self {
        let max_conn = config.max_connections;
        Self {
            traffic: Arc::new(RwLock::new(TrafficStats::new(config.traffic_minute_window))),
            config,
            admin_user_id,
            users: DashMap::new(),
            user_quotas: DashMap::new(),
            user_session_counts: DashMap::new(),
            watchers: DashMap::new(),
            watch_targets: DashMap::new(),
            db: db_tx,
            conn_semaphore: Arc::new(Semaphore::new(max_conn)),
        }
    }

    #[inline]
    pub fn is_admin(&self, user_id: &str) -> bool {
        self.admin_user_id.as_deref() == Some(user_id)
    }

    // ── 转发额度 ──

    pub fn get_or_create_user_quota(&self, user_id: &str) -> UserRelayQuota {
        if let Some(q) = self.user_quotas.get(user_id) {
            return q.clone();
        }
        let quota = UserRelayQuota {
            user_id: user_id.to_string(),
            quota_bytes: self.config.default_relay_quota_bytes,
            used_bytes: 0,
            updated_at: protocol::now_ms(),
        };
        self.user_quotas.insert(user_id.to_string(), quota.clone());
        quota
    }

    pub fn check_relay_quota(&self, user_id: &str, msg_size: u64) -> bool {
        if self.is_admin(user_id) {
            return true;
        }
        let quota = self.get_or_create_user_quota(user_id);
        if quota.used_bytes < quota.quota_bytes {
            return true;
        }
        msg_size <= self.config.relay_small_message_max_bytes
    }

    pub fn record_relay_usage(&self, user_id: &str, bytes: u64) {
        if self.is_admin(user_id) {
            return;
        }
        let now = protocol::now_ms();
        self.user_quotas
            .entry(user_id.to_string())
            .and_modify(|q| {
                q.used_bytes = q.used_bytes.saturating_add(bytes);
                q.updated_at = now;
            })
            .or_insert_with(|| UserRelayQuota {
                user_id: user_id.to_string(),
                quota_bytes: self.config.default_relay_quota_bytes,
                used_bytes: bytes,
                updated_at: now,
            });
    }

    pub fn set_user_relay_quota(&self, user_id: &str, quota_bytes: u64) -> UserRelayQuota {
        let now = protocol::now_ms();
        let mut quota = self.get_or_create_user_quota(user_id);
        quota.quota_bytes = quota_bytes;
        quota.updated_at = now;
        self.user_quotas.insert(user_id.to_string(), quota.clone());

        // 异步通知 DB actor
        if let Some(ref db_tx) = self.db {
            let _ = db_tx.send(db::DbCmd::SaveUserRelayQuota {
                user_id: user_id.to_string(),
                quota_bytes,
                used_bytes: quota.used_bytes,
                updated_at: now,
            });
        }
        quota
    }

    // ── 用户连接管理 ──

    pub fn add_user(
        &self,
        conn_key: &str,
        username: &str,
        host: &str,
        addr: SocketAddr,
        disconnect_tx: oneshot::Sender<()>,
        data_tx: mpsc::UnboundedSender<Message>,
    ) -> Result<(), String> {
        let user_id = conn_key.split(':').next().unwrap_or(conn_key).to_string();

        // 踢掉同 key 的旧连接
        if let Some((_, mut old_session)) = self.users.remove(conn_key) {
            if let Some(tx) = old_session.disconnect_tx.take() {
                let _ = tx.send(());
            }
            self.user_session_counts.entry(user_id.clone()).and_modify(|c| *c = c.saturating_sub(1));
        }

        let current_count = self.user_session_counts.get(&user_id).map(|c| *c).unwrap_or(0);
        if current_count >= self.config.max_sessions_per_user {
            return Err(format!(
                "User {} has reached the maximum number of concurrent sessions ({}), please disconnect some sessions first",
                user_id, self.config.max_sessions_per_user
            ));
        }

        let now = protocol::now_ms();
        self.users.insert(conn_key.to_string(), UserSession {
            username: username.to_string(),
            host: host.to_string(),
            addr,
            disconnect_tx: Some(disconnect_tx),
            data_tx,
            latency_ms: None,
            connected_at: now,
            relay_fail_count: 0,
            relay_fail_window_start: now,
            services: Vec::new(),
        });

        self.user_session_counts.entry(user_id).and_modify(|c| *c += 1).or_insert(1);
        Ok(())
    }

    pub fn remove_user(&self, conn_key: &str) {
        if let Some((_, _session)) = self.users.remove(conn_key) {
            let user_id = conn_key.split(':').next().unwrap_or(conn_key);
            self.user_session_counts.entry(user_id.to_string()).and_modify(|c| *c = c.saturating_sub(1));
        }
    }

    pub fn get_session_data_tx(&self, user_id: &str, session_id: &str) -> Option<mpsc::UnboundedSender<Message>> {
        let conn_key = format!("{}:{}", user_id, session_id);
        self.users.get(&conn_key).map(|s| s.data_tx.clone())
    }

    // ── 延迟 ──

    pub fn update_latency(&self, user_id: &str, session_id: &str, rtt: u64) {
        let conn_key = format!("{}:{}", user_id, session_id);
        if let Some(mut session) = self.users.get_mut(&conn_key) {
            session.latency_ms = Some(rtt);
        }
    }

    pub fn get_user_sessions_with_latency(&self, user_id: &str) -> Vec<serde_json::Value> {
        let prefix = format!("{}:", user_id);
        self.users.iter()
            .filter(|r| r.key().starts_with(&prefix))
            .map(|r| {
                let k = r.key();
                let session = r.value();
                let parts: Vec<&str> = k.splitn(2, ':').collect();
                let session_id = if parts.len() == 2 { parts[1].to_string() } else { String::new() };
                serde_json::json!({
                    "sessionId": session_id,
                    "latencyMs": session.latency_ms,
                    "services": session.services,
                })
            })
            .collect()
    }

    // ── 中继风暴防护 ──

    pub fn record_relay_failure(&self, conn_key: &str) -> bool {
        let now = protocol::now_ms();
        let window_ms = self.config.relay_fail_window_secs * 1000;
        if let Some(mut session) = self.users.get_mut(conn_key) {
            if now.saturating_sub(session.relay_fail_window_start) >= window_ms {
                session.relay_fail_window_start = now;
                session.relay_fail_count = 1;
            } else {
                session.relay_fail_count = session.relay_fail_count.saturating_add(1);
            }
            session.relay_fail_count >= self.config.relay_fail_limit
        } else {
            false
        }
    }

    pub fn reset_relay_failure(&self, conn_key: &str) {
        if let Some(mut session) = self.users.get_mut(conn_key) {
            session.relay_fail_count = 0;
        }
    }

    pub fn handle_relay_failure(&self, user_id: &str, session_id: &str) -> bool {
        let conn_key = format!("{}:{}", user_id, session_id);
        if self.record_relay_failure(&conn_key) {
            self.disconnect_session(user_id, session_id);
            true
        } else {
            false
        }
    }

    // ── 断开连接 ──

    pub fn disconnect_user_by_id(&self, target_user_id: &str) -> usize {
        let prefix = format!("{}:", target_user_id);
        let mut count = 0;
        self.users.retain(|key, session| {
            if key.starts_with(&prefix) {
                if let Some(tx) = session.disconnect_tx.take() {
                    let _ = tx.send(());
                }
                count += 1;
                false
            } else {
                true
            }
        });
        if count > 0 {
            self.user_session_counts.entry(target_user_id.to_string()).and_modify(|c| *c = c.saturating_sub(count));
        }
        count
    }

    pub fn disconnect_session(&self, target_user_id: &str, target_session_id: &str) -> bool {
        let conn_key = format!("{}:{}", target_user_id, target_session_id);
        if let Some((_, mut session)) = self.users.remove(&conn_key) {
            if let Some(tx) = session.disconnect_tx.take() {
                let _ = tx.send(());
            }
            self.user_session_counts.entry(target_user_id.to_string()).and_modify(|c| *c = c.saturating_sub(1));
            true
        } else {
            false
        }
    }

    // ── 关注者系统 ──

    pub fn add_watcher(&self, watcher_conn_key: &str, watched_user_id: &str, data_tx: mpsc::UnboundedSender<Message>) {
        let watchers = self.watchers.entry(watched_user_id.to_string()).or_default();
        watchers.insert(watcher_conn_key.to_string(), data_tx);
        let mut targets = self.watch_targets.entry(watcher_conn_key.to_string()).or_default();
        if !targets.contains(&watched_user_id.to_string()) {
            targets.push(watched_user_id.to_string());
        }
    }

    pub fn remove_watcher(&self, watcher_conn_key: &str, watched_user_id: &str) {
        if let Some(watchers) = self.watchers.get_mut(watched_user_id) {
            watchers.remove(watcher_conn_key);
        }
        if let Some(mut targets) = self.watch_targets.get_mut(watcher_conn_key) {
            targets.retain(|id| id != watched_user_id);
        }
    }

    pub fn remove_all_watchers(&self, watcher_conn_key: &str) {
        if let Some(targets) = self.watch_targets.get(watcher_conn_key) {
            let watched_ids: Vec<String> = targets.clone();
            drop(targets);
            for watched_id in &watched_ids {
                if let Some(watchers) = self.watchers.get_mut(watched_id) {
                    watchers.remove(watcher_conn_key);
                }
            }
        }
        self.watch_targets.remove(watcher_conn_key);
    }

    pub fn notify_watchers_session_left(&self, user_id: &str, session_id: &str, username: &str) {
        if let Some(watchers) = self.watchers.get(user_id) {
            let notify = serde_json::json!({
                "type": "session_server_left",
                "user_id": user_id,
                "session_id": session_id,
                "username": username,
            });
            if let Ok(text) = serde_json::to_string(&notify) {
                for w in watchers.iter() {
                    let _ = w.value().send(Message::Text(text.clone()));
                }
            }
        }
    }

    // ── 服务注册 ──

    pub fn update_services(&self, user_id: &str, session_id: &str, services: Vec<String>) {
        let conn_key = format!("{}:{}", user_id, session_id);
        if let Some(mut session) = self.users.get_mut(&conn_key) {
            session.services = services;
        }
    }

    // ── 用户列表查询 ──

    pub fn get_all_users(&self) -> Vec<serde_json::Value> {
        self.users.iter().map(|r| {
            let conn_key = r.key();
            let session = r.value();
            let parts: Vec<&str> = conn_key.splitn(2, ':').collect();
            let (user_id, session_id) = if parts.len() == 2 {
                (parts[0].to_string(), parts[1].to_string())
            } else {
                (conn_key.clone(), String::new())
            };
            serde_json::json!({
                "userId": user_id,
                "sessionId": session_id,
                "username": session.username,
                "host": session.host,
                "addr": session.addr.to_string(),
                "latencyMs": session.latency_ms,
                "connectedAt": session.connected_at,
            })
        }).collect()
    }

    pub fn get_users_paginated(&self, page: u32, page_size: u32) -> (Vec<serde_json::Value>, u32) {
        let all = self.get_all_users();
        let total = all.len() as u32;
        let page = page.max(1) as usize;
        let page_size = (page_size.clamp(1, 100)) as usize;
        let start = (page - 1) * page_size;
        if start >= all.len() {
            return (Vec::new(), total);
        }
        let end = start + page_size.min(all.len() - start);
        (all[start..end].to_vec(), total)
    }
}
