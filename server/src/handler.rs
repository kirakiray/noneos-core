use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, mpsc};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{accept_hdr_async, tungstenite::{protocol::Message, handshake::server::{Request, Response, ErrorResponse}}};
use serde::{Deserialize, Serialize};
use crate::crypto::verify_signature;
use crate::config::Config;
use crate::traffic;
use rand::{thread_rng, Rng};
use rand::distributions::Alphanumeric;
use sysinfo::{System, Disks};
use std::sync::OnceLock;

use dashmap::DashMap;

/// 已连接用户的信息
pub struct UserSession {
    username: String,
    host: String,
    addr: SocketAddr,
    disconnect_tx: Option<oneshot::Sender<()>>,
    data_tx: mpsc::UnboundedSender<Message>, // 用于转发消息的目标通道
    latency_ms: Option<u64>,                  // 最近一次延迟测量的 RTT（毫秒）
    connected_at: u64,                        // 连接建立时的 Unix 时间戳（毫秒）
    /// 当前 relay 失败计数窗口内，已发生 relay 到不存在 session 的次数
    relay_fail_count: u32,
    /// relay 失败计数窗口开始时间（Unix 毫秒）
    relay_fail_window_start: u64,
}

/// 应用共享状态，存储所有已连接用户和管理员配置
/// 用户以 "userId:sessionId" 为 key 存储，同一 userId 的不同 sessionId 可同时连接
pub struct AppState {
    pub admin_user_id: Option<String>,
    pub config: Config,
    pub traffic: std::sync::Mutex<traffic::TrafficStats>,
    pub user_quotas: DashMap<String, traffic::UserRelayQuota>,
    users: DashMap<String, UserSession>,
}

impl AppState {
    pub fn new(admin_user_id: Option<String>, config: Config) -> Self {
        Self {
            admin_user_id: admin_user_id.clone(),
            traffic: std::sync::Mutex::new(traffic::TrafficStats::new(config.traffic_minute_window)),
            config,
            users: DashMap::new(),
            user_quotas: DashMap::new(),
        }
    }

    /// 判断指定用户是否为管理员
    pub fn is_admin(&self, user_id: &str) -> bool {
        self.admin_user_id.as_deref() == Some(user_id)
    }

    /// 获取或创建用户的转发额度（内存中）
    pub fn get_or_create_user_quota(&self, user_id: &str) -> traffic::UserRelayQuota {
        if let Some(q) = self.user_quotas.get(user_id) {
            return q.clone();
        }
        let quota = traffic::UserRelayQuota {
            user_id: user_id.to_string(),
            quota_bytes: self.config.default_relay_quota_bytes,
            used_bytes: 0,
            updated_at: traffic::now_ms(),
        };
        self.user_quotas.insert(user_id.to_string(), quota.clone());
        quota
    }

    /// 检查用户是否允许转发指定大小的消息。
    /// 管理员始终允许；未超额允许；超额后仅允许 <= small_message_max_bytes 的消息。
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

    /// 记录用户转发用量
    pub fn record_relay_usage(&self, user_id: &str, bytes: u64) {
        if self.is_admin(user_id) {
            return;
        }
        let now = traffic::now_ms();
        self.user_quotas
            .entry(user_id.to_string())
            .and_modify(|q| {
                q.used_bytes = q.used_bytes.saturating_add(bytes);
                q.updated_at = now;
            })
            .or_insert_with(|| traffic::UserRelayQuota {
                user_id: user_id.to_string(),
                quota_bytes: self.config.default_relay_quota_bytes,
                used_bytes: bytes,
                updated_at: now,
            });
    }

    /// 设置用户转发额度（admin 用），并立即持久化到 DB（如果配置了 DB）
    pub fn set_user_relay_quota(&self, user_id: &str, quota_bytes: u64) -> traffic::UserRelayQuota {
        let now = traffic::now_ms();
        let mut quota = self.get_or_create_user_quota(user_id);
        quota.quota_bytes = quota_bytes;
        quota.updated_at = now;
        self.user_quotas.insert(user_id.to_string(), quota.clone());

        if let Some(ref db_path) = self.config.traffic_db_path {
            let quota_clone = quota.clone();
            let path_clone = db_path.clone();
            tokio::spawn(async move {
                if let Ok(conn) = rusqlite::Connection::open(path_clone) {
                    if let Err(e) = traffic::save_user_relay_quota(&conn, &quota_clone) {
                        eprintln!("Failed to save user quota to DB: {}", e);
                    }
                }
            });
        }

        quota
    }

    /// 添加用户连接
    /// - 如果相同的 conn_key 已存在，踢掉旧连接再替换
    /// - 如果该 userId 的 session 数已达 max_sessions_per_user 上限，返回 Err
    pub fn add_user(&self, conn_key: &str, username: &str, host: &str, addr: SocketAddr, disconnect_tx: oneshot::Sender<()>, data_tx: mpsc::UnboundedSender<Message>) -> Result<(), String> {
        // 解析 userId
        let user_id = conn_key.split(':').next().unwrap_or(conn_key).to_string();

        // 如果相同 key 已存在，先踢掉旧连接（同一 session 重连）
        if let Some((_, mut old_session)) = self.users.remove(conn_key) {
            if let Some(tx) = old_session.disconnect_tx.take() {
                let _ = tx.send(());
            }
        }

        // 检查该 userId 的当前 session 数
        let prefix = format!("{}:", user_id);
        let current_count = self.users.iter()
            .filter(|r| r.key().starts_with(&prefix))
            .count();
        
        if current_count >= self.config.max_sessions_per_user {
            return Err(format!(
                "User {} has reached the maximum number of concurrent sessions ({}), please disconnect some sessions first",
                user_id, self.config.max_sessions_per_user
            ));
        }

        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        
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
        });
        Ok(())
    }

    pub fn remove_user(&self, conn_key: &str) -> Option<UserSession> {
        self.users.remove(conn_key).map(|(_, s)| s)
    }

    /// 根据 userId 踢掉该用户的所有连接（用于管理员断开用户）
    pub fn disconnect_user_by_id(&self, target_user_id: &str) -> usize {
        let prefix = format!("{}:", target_user_id);
        let mut count = 0;
        
        // 使用 DashMap 的 retain 来安全地删除并处理
        self.users.retain(|key, session| {
            if key.starts_with(&prefix) {
                if let Some(tx) = session.disconnect_tx.take() {
                    let _ = tx.send(());
                }
                count += 1;
                false // 移除
            } else {
                true // 保留
            }
        });
        count
    }

    /// 断开指定 session（conn_key = userId:sessionId）
    pub fn disconnect_session(&self, target_user_id: &str, target_session_id: &str) -> bool {
        let conn_key = format!("{}:{}", target_user_id, target_session_id);
        if let Some((_, mut session)) = self.users.remove(&conn_key) {
            if let Some(tx) = session.disconnect_tx.take() {
                let _ = tx.send(());
            }
            true
        } else {
            false
        }
    }

    pub fn get_all_users(&self) -> Vec<serde_json::Value> {
        self.users.iter().map(|r| {
            let conn_key = r.key();
            let session = r.value();
            // 从 conn_key (userId:sessionId) 中拆分出 userId 和 sessionId
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

    /// 分页获取用户列表
    /// 返回 (分页后的用户列表, 总用户数)
    pub fn get_users_paginated(&self, page: u32, page_size: u32) -> (Vec<serde_json::Value>, u32) {
        let all_users = self.get_all_users();
        let total = all_users.len() as u32;
        let page = page.max(1) as usize;
        let page_size = page_size.max(1).min(100) as usize;
        let start = (page - 1) * page_size;
        if start >= all_users.len() {
            return (Vec::new(), total);
        }
        let end = start + page_size.min(all_users.len() - start);
        (all_users[start..end].to_vec(), total)
    }

    /// 按 userId 分组分页获取用户组
    /// 每个用户组包含 userId, username, sessionCount 和 sessions[] 列表
    /// 返回 (分页后的用户组列表, 总用户数（去重后）)
    pub fn get_user_groups_paginated(&self, page: u32, page_size: u32) -> (Vec<serde_json::Value>, u32) {
        // 按 userId 分组
        use std::collections::BTreeMap;
        let mut user_map: BTreeMap<String, (String, String, Vec<serde_json::Value>)> = BTreeMap::new();

        for r in self.users.iter() {
            let conn_key = r.key();
            let session = r.value();
            let parts: Vec<&str> = conn_key.splitn(2, ':').collect();
            let user_id = parts[0].to_string();
            let session_id = if parts.len() == 2 { parts[1].to_string() } else { String::new() };

            let session_json = serde_json::json!({
                "sessionId": session_id,
                "host": session.host,
                "addr": session.addr.to_string(),
                "latencyMs": session.latency_ms,
                "connectedAt": session.connected_at,
            });

            let entry = user_map.entry(user_id.clone()).or_insert_with(|| {
                (user_id.clone(), session.username.clone(), Vec::new())
            });
            entry.2.push(session_json);
        }

        let total = user_map.len() as u32;

        let all_groups: Vec<serde_json::Value> = user_map.into_iter().map(|(_key, (user_id, username, sessions))| {
            serde_json::json!({
                "userId": user_id,
                "username": username,
                "sessionCount": sessions.len(),
                "sessions": sessions,
            })
        }).collect();

        // 分页
        let page = page.max(1) as usize;
        let page_size = page_size.max(1).min(100) as usize;
        let start = (page - 1) * page_size;
        if start >= all_groups.len() {
            return (Vec::new(), total);
        }
        let end = start + page_size.min(all_groups.len() - start);
        (all_groups[start..end].to_vec(), total)
    }

    /// 获取指定 userId 的所有 sessionId 及其延迟数据
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
                })
            })
            .collect()
    }

    /// 获取指定 session 的 data_tx 通道
    pub fn get_session_data_tx(&self, user_id: &str, session_id: &str) -> Option<mpsc::UnboundedSender<Message>> {
        let conn_key = format!("{}:{}", user_id, session_id);
        self.users.get(&conn_key).map(|s| s.data_tx.clone())
    }

    /// 更新指定 session 的延迟数据
    pub fn update_latency(&self, user_id: &str, session_id: &str, rtt: u64) {
        let conn_key = format!("{}:{}", user_id, session_id);
        if let Some(mut session) = self.users.get_mut(&conn_key) {
            session.latency_ms = Some(rtt);
        }
    }

    /// 记录一次 relay 到不存在 session 的失败，返回是否达到踢出阈值
    pub fn record_relay_failure(&self, conn_key: &str) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let window_ms = self.config.relay_fail_window_secs * 1000;

        if let Some(mut session) = self.users.get_mut(conn_key) {
            if now.saturating_sub(session.relay_fail_window_start) >= window_ms {
                // 窗口已过期，重置
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

    /// relay 成功时重置失败计数（目标 session 存在，转发成功）
    pub fn reset_relay_failure(&self, conn_key: &str) {
        if let Some(mut session) = self.users.get_mut(conn_key) {
            session.relay_fail_count = 0;
        }
    }

    /// 处理一次 relay 失败：累加计数，达到踢出阈值时移除 session 并返回 true
    pub fn handle_relay_failure(&self, user_id: &str, session_id: &str) -> bool {
        let conn_key = format!("{}:{}", user_id, session_id);
        let should_kick = self.record_relay_failure(&conn_key);
        if should_kick {
            self.disconnect_session(user_id, session_id);
        }
        should_kick
    }
}

/// 握手阶段返回给客户端的响应格式
#[derive(Serialize)]
struct HandshakeResponse {
    #[serde(rename = "type")]
    msg_type: String,
    status: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    is_admin: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

/// 挑战信息格式
#[derive(Serialize)]
struct HandshakeChallenge {
    #[serde(rename = "type")]
    msg_type: String,
    challenge: String,
}

/// 管理命令请求格式
#[derive(Deserialize)]
struct AdminCommand {
    action: String,
    #[serde(default)]
    user_id: Option<String>,
    #[serde(default)]
    user_ids: Option<Vec<String>>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default = "default_page")]
    page: u32,
    #[serde(default = "default_page_size")]
    page_size: u32,
    #[serde(default)]
    limit: Option<usize>,
    /// 可选：流量历史查询的起始时间戳（毫秒）。不传则默认查最近 1 小时。
    #[serde(default)]
    from_ms: Option<i64>,
    /// 可选：设置用户转发额度（字节）
    #[serde(default)]
    quota_bytes: Option<u64>,
}

fn default_page() -> u32 { 1 }
fn default_page_size() -> u32 { 20 }

/// 管理命令响应格式
#[derive(Default, Serialize)]
struct AdminResponse {
    #[serde(rename = "type")]
    msg_type: String,
    action: String,
    status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    users: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_info: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    page_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    traffic: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    history: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_inbound_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_outbound_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_relay_forwarded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total_handshake_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    system_stats: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quota: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    quotas: Option<Vec<serde_json::Value>>,
}

/// 获取当前内存使用率百分比（带 1 秒缓存，减少频繁调用开销）
fn get_memory_usage_percent() -> f64 {
    static CACHE: OnceLock<std::sync::Mutex<(f64, std::time::Instant)>> = OnceLock::new();
    let cache_mutex = CACHE.get_or_init(|| {
        std::sync::Mutex::new((0.0, std::time::Instant::now() - Duration::from_secs(10)))
    });

    let mut cache = cache_mutex.lock().unwrap();
    if cache.1.elapsed() < Duration::from_secs(1) {
        return cache.0;
    }

    static SYSTEM: OnceLock<std::sync::Mutex<System>> = OnceLock::new();
    let mut system = SYSTEM.get_or_init(|| {
        std::sync::Mutex::new(System::new_all())
    }).lock().unwrap();

    system.refresh_memory();
    let total = system.total_memory();
    let usage = if total == 0 {
        0.0
    } else {
        (system.used_memory() as f64 / total as f64 * 100.0 * 100.0).round() / 100.0
    };

    cache.0 = usage;
    cache.1 = std::time::Instant::now();
    usage
}

/// 收集系统信息（内存、CPU、磁盘使用情况，带 1 秒缓存）
fn collect_system_info() -> serde_json::Value {
    static CACHE: OnceLock<std::sync::Mutex<(serde_json::Value, std::time::Instant)>> = OnceLock::new();
    let cache_mutex = CACHE.get_or_init(|| {
        std::sync::Mutex::new((serde_json::Value::Null, std::time::Instant::now() - Duration::from_secs(10)))
    });

    let mut cache = cache_mutex.lock().unwrap();
    if cache.1.elapsed() < Duration::from_secs(1) {
        return cache.0.clone();
    }

    static SYSTEM: OnceLock<std::sync::Mutex<System>> = OnceLock::new();
    let mut system = SYSTEM.get_or_init(|| {
        std::sync::Mutex::new(System::new_all())
    }).lock().unwrap();

    // 刷新内存（快照型，一次即可）
    system.refresh_memory();
    // 刷新 CPU：至少需要两次刷新才能得到有意义的差值
    system.refresh_cpu_all();
    let disks = Disks::new_with_refreshed_list();

    // 内存信息（字节）
    let total_memory = system.total_memory();
    let used_memory = system.used_memory();
    let available_memory = system.available_memory();

    // CPU 信息：返回每个核心的单独占用率
    let cpu_count = system.cpus().len();
    let cores: Vec<serde_json::Value> = system.cpus().iter().enumerate().map(|(i, cpu)| {
        serde_json::json!({
            "index": i,
            "usage_percent": (cpu.cpu_usage() * 100.0).round() / 100.0,
        })
    }).collect();

    // 磁盘信息
    let disk_list: Vec<serde_json::Value> = disks.iter().map(|disk| {
        serde_json::json!({
            "mount_point": disk.mount_point().to_string_lossy(),
            "total_space": disk.total_space(),
            "available_space": disk.available_space(),
            "file_system": disk.file_system().to_string_lossy(),
        })
    }).collect();

    let info = serde_json::json!({
        "memory": {
            "total": total_memory,
            "used": used_memory,
            "available": available_memory,
            "usage_percent": if total_memory > 0 {
                (used_memory as f64 / total_memory as f64 * 100.0 * 100.0).round() / 100.0
            } else {
                0.0
            },
        },
        "cpu": {
            "core_count": cpu_count,
            "cores": cores,
        },
        "disks": disk_list,
    });

    cache.0 = info.clone();
    cache.1 = std::time::Instant::now();
    info
}

/// 核心业务函数：处理单个 WebSocket 连接的完整生命周期
pub async fn handle_connection(
    raw_stream: TcpStream,
    addr: SocketAddr,
    state: Arc<AppState>,
    handshake_timeout_secs: u64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("New WebSocket connection attempt from: {}", addr);

    // 1. WebSocket 握手，并捕获 Origin 请求头（由浏览器自动发送，更可信）
    let client_origin = std::sync::Mutex::new(String::new());
    let ws_stream = accept_hdr_async(raw_stream, |req: &Request, response: Response| {
        if let Some(origin_val) = req.headers().get("origin") {
            if let Ok(origin_str) = origin_val.to_str() {
                if let Ok(mut origin) = client_origin.lock() {
                    *origin = origin_str.to_string();
                }
            }
        }
        Ok::<_, ErrorResponse>(response)
    }).await?;
    let client_origin = client_origin.into_inner().unwrap_or_default();
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // 2. 发送挑战
    let challenge: String = thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    let challenge_msg = HandshakeChallenge {
        msg_type: "handshake_challenge".to_string(),
        challenge: challenge.clone(),
    };
    ws_sender.send(Message::Text(serde_json::to_string(&challenge_msg)?)).await?;

    // 3. 接收响应 (可配置超时)
    let handshake_data = match timeout(Duration::from_secs(handshake_timeout_secs), ws_receiver.next()).await {
        Ok(Some(Ok(Message::Text(text)))) => {
            let handshake_max_size = state.config.handshake_max_size;
            if text.len() > handshake_max_size {
                let resp = HandshakeResponse {
                    msg_type: "handshake".to_string(),
                    status: "error".to_string(),
                    message: format!("Handshake data too large: {} bytes (max {} bytes)", text.len(), handshake_max_size),
                    is_admin: None,
                    version: None,
                };
                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                let _ = ws_sender.send(Message::Close(None)).await;
                return Err("Handshake failed: Handshake data too large".into());
            }
            text
        }
        Ok(Some(Ok(_))) => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Expected text message during handshake".to_string(),
                is_admin: None,
                version: None,
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            let _ = ws_sender.send(Message::Close(None)).await;
            return Err("Handshake failed: Unexpected message type".into());
        }
        Err(_elapsed) => {
            // 超时：指定时间内未收到任何响应
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: format!("Handshake timeout: no response within {} seconds", handshake_timeout_secs),
                is_admin: None,
                version: None,
            };
            let _ = ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await;
            let _ = ws_sender.send(Message::Close(None)).await;
            return Err("Handshake failed: timeout waiting for response".into());
        }
        _ => {
            let _ = ws_sender.send(Message::Close(None)).await;
            return Err("Handshake failed: Connection closed by client".into());
        }
    };

    // 捕获握手数据大小（用于流量统计）
    let handshake_size = handshake_data.len();

    // 4. 数据解析
    let mut handshake_obj: serde_json::Map<String, serde_json::Value> = match serde_json::from_str(&handshake_data) {
        Ok(serde_json::Value::Object(v)) => v,
        _ => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Invalid JSON format or not an object".to_string(),
                is_admin: None,
                version: None,
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("Handshake failed: Invalid JSON".into());
        }
    };

    // 5. 挑战校验
    let received_challenge = match handshake_obj.get("challenge").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Missing 'challenge' field".to_string(),
                is_admin: None,
                version: None,
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("Handshake failed: Missing challenge".into());
        }
    };

    if received_challenge != challenge {
        let resp = HandshakeResponse {
            msg_type: "handshake".to_string(),
            status: "error".to_string(),
            message: "Challenge mismatch".to_string(),
            is_admin: None,
            version: None,
        };
        ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
        return Err("Handshake failed: Challenge mismatch".into());
    }

    // 6. 提取字段
    let signature = match handshake_obj.get("signature").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Missing 'signature' field".to_string(),
                is_admin: None,
                version: None,
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("Handshake failed: Missing signature".into());
        }
    };

    let public_key = match handshake_obj.get("publicKey").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Missing 'publicKey' field".to_string(),
                is_admin: None,
                version: None,
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("Handshake failed: Missing publicKey".into());
        }
    };

    // 提取 userId、sessionId 和 username
    let user_id = handshake_obj.get("userId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let session_id = handshake_obj.get("sessionId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let username = handshake_obj.get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

    // 以 userId + sessionId 作为连接 key，同一 userId 的不同 sessionId 可共存
    let conn_key = format!("{}:{}", user_id, session_id);

    // 7. 签名验证
    handshake_obj.remove("signature");
    let signed_message = serde_json::to_string(&handshake_obj)?;

    match verify_signature(&public_key, &signed_message, &signature) {
        Ok(_) => {
            // 判断是否为管理员
            let is_admin = state.admin_user_id.as_deref() == Some(&user_id);

            // 内存过载保护：非管理员且内存使用率超过阈值时拒绝连接
            if !is_admin {
                let threshold = state.config.max_memory_usage_percent;
                let mem_usage = get_memory_usage_percent();
                if mem_usage > threshold {
                    let msg = format!(
                        "Server memory usage is too high ({}% > {}%), connection rejected. Please try again later.",
                        mem_usage, threshold
                    );
                    println!("Rejected connection from {}:{} ({}) — {}", user_id, session_id, username, msg);
                    let resp = HandshakeResponse {
                        msg_type: "handshake".to_string(),
                        status: "error".to_string(),
                        message: msg,
                        is_admin: None,
                        version: None,
                    };
                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                    let _ = ws_sender.send(Message::Close(None)).await;
                    return Err("Handshake rejected: server memory overload".into());
                }
            }

            // 创建 disconnect 通道 and data 转发通道并注册用户（以 userId:sessionId 为 key）
            let (disconnect_tx, mut disconnect_rx) = oneshot::channel::<()>();
            let (data_tx, mut data_rx) = mpsc::unbounded_channel::<Message>();
            if let Err(e) = state.add_user(&conn_key, &username, &client_origin, addr, disconnect_tx, data_tx) {
                let resp = HandshakeResponse {
                    msg_type: "handshake".to_string(),
                    status: "error".to_string(),
                    message: e.clone(),
                    is_admin: None,
                    version: None,
                };
                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                let _ = ws_sender.send(Message::Close(None)).await;
                return Err(format!("Handshake rejected: {}", e).into());
            }

            // 在流量统计中注册该 session
            {
                let mut tr = state.traffic.lock().unwrap();
                let now_ms = traffic::now_ms();
                tr.register_session(&conn_key, &user_id, &session_id, &username, now_ms);
                tr.add_handshake(&conn_key, handshake_size as u64, now_ms);
            }

            // 持久化用户信息到数据库（异步，不阻塞连接）
            if let Some(ref db_path) = state.config.traffic_db_path {
                let db_path_clone = db_path.clone();
                let user_record = traffic::UserRecord {
                    user_id: user_id.clone(),
                    username: username.clone(),
                    public_key: public_key.clone(),
                    first_seen_at: traffic::now_ms(),
                    last_seen_at: traffic::now_ms(),
                };
                tokio::spawn(async move {
                    if let Ok(conn) = rusqlite::Connection::open(db_path_clone) {
                        if let Err(e) = traffic::save_user(&conn, &user_record) {
                            eprintln!("Failed to persist user {} to DB: {}", user_record.user_id, e);
                        }
                    }
                });
            }

            let role_str = if is_admin { " (ADMIN)" } else { "" };
            println!("Handshake: User {}:{} ({}) authenticated successfully{}", user_id, session_id, username, role_str);

            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "success".to_string(),
                message: "Authentication successful".to_string(),
                is_admin: Some(is_admin),
                version: Some(env!("CARGO_PKG_VERSION").to_string()),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;

            // 8. 通信循环
            loop {
                tokio::select! {
                    // 接收 disconnect 信号
                    _ = &mut disconnect_rx => {
                        println!("User {}:{} ({}) disconnected by admin", user_id, session_id, username);
                        let _ = ws_sender.send(Message::Close(None)).await;
                        break;
                    }
                    // 接收转发消息（其他用户通过 relay 发送过来的数据）
                    Some(forward_msg) = data_rx.recv() => {
                        // 统计出站流量（转发给当前连接的消息）
                        let out_size = traffic::message_byte_size(&forward_msg) as u64;
                        if out_size > 0 {
                            state.traffic.lock().unwrap().add_outbound(&conn_key, out_size, traffic::now_ms());
                        }
                        ws_sender.send(forward_msg).await?;
                    }
                    // 接收客户端消息
                    msg = ws_receiver.next() => {
                        match msg {
                            Some(Ok(msg)) => {
                                match msg {
                                    Message::Text(text) => {
                                        // 检查文本消息大小，防止 OOM
                                        let text_max_size = state.config.text_message_max_size;
                                        if text.len() > text_max_size {
                                            println!("Oversized text message ({} bytes) from {}:{} ({}), rejected", text.len(), user_id, session_id, username);
                                            let resp = serde_json::json!({
                                                "type": "error",
                                                "status": "error",
                                                "message": format!("Text message too large: {} bytes (max {} bytes)", text.len(), text_max_size)
                                            });
                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                            continue;
                                        }

                                        // 截断日志输出，避免打印超长消息
                                        let log_text = if text.len() > 500 {
                                            format!("{}... ({} bytes total)", &text[..500], text.len())
                                        } else {
                                            text.clone()
                                        };
                                        println!("Message from {}:{} ({}){}: {}", user_id, session_id, username, role_str, log_text);

                                        // 统计入站流量
                                        {
                                            state.traffic.lock().unwrap().add_inbound(&conn_key, text.len() as u64, traffic::now_ms());
                                        }

                                        // 尝试解析为 JSON 命令
                                        if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&text) {
                                            let msg_type = cmd.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                            // 处理管理命令
                                            if msg_type == "admin" {
                                                if let Ok(admin_cmd) = serde_json::from_str::<AdminCommand>(&text) {
                                                    if !is_admin {
                                                        let resp = AdminResponse {
                                                            msg_type: "admin_response".to_string(),
                                                            action: admin_cmd.action,
                                                            status: "error".to_string(),
                                                            message: Some("Permission denied: not an admin".to_string()),
                                                            users: None,
                                                            system_info: None,
                                                            ..Default::default()
                                                        };
                                                        ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        continue;
                                                    }

                                                    match admin_cmd.action.as_str() {
                                                        "list_users" => {
                                                            let (users, total) = state.get_users_paginated(admin_cmd.page, admin_cmd.page_size);
                                                            let count = users.len();
                                                            let resp = AdminResponse {
                                                                msg_type: "admin_response".to_string(),
                                                                action: "list_users".to_string(),
                                                                status: "ok".to_string(),
                                                                message: Some(format!("{} user(s) connected", count)),
                                                                users: Some(users),
                                                                system_info: None,
                                                                total: Some(total),
                                                                page: Some(admin_cmd.page),
                                                                page_size: Some(admin_cmd.page_size),
                                                                ..Default::default()
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        }
                                                        "list_user_groups" => {
                                                            let (users, total) = state.get_user_groups_paginated(admin_cmd.page, admin_cmd.page_size);
                                                            let count = users.len();
                                                            let resp = AdminResponse {
                                                                msg_type: "admin_response".to_string(),
                                                                action: "list_user_groups".to_string(),
                                                                status: "ok".to_string(),
                                                                message: Some(format!("{} user group(s) connected", count)),
                                                                users: Some(users),
                                                                system_info: None,
                                                                total: Some(total),
                                                                page: Some(admin_cmd.page),
                                                                page_size: Some(admin_cmd.page_size),
                                                                ..Default::default()
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        }
                                                        "list_all_users" => {
                                                            // 从数据库查询所有用户（包括离线的）
                                                            if let Some(ref db_path) = state.config.traffic_db_path {
                                                                match rusqlite::Connection::open(db_path) {
                                                                    Ok(conn) => {
                                                                        match traffic::query_users_paginated(&conn, admin_cmd.page, admin_cmd.page_size) {
                                                                            Ok((mut users, total)) => {
                                                                                // 为查询结果添加在线状态标记
                                                                                for user in users.iter_mut() {
                                                                                    if let Some(user_id_val) = user.get("userId").and_then(|v| v.as_str()) {
                                                                                        let prefix = format!("{}:", user_id_val);
                                                                                        let is_online = state.users.iter().any(|r| r.key().starts_with(&prefix));
                                                                                        if let Some(obj) = user.as_object_mut() {
                                                                                            obj.insert("isOnline".to_string(), serde_json::Value::Bool(is_online));
                                                                                        }
                                                                                    }
                                                                                }

                                                                                let resp = AdminResponse {
                                                                                    msg_type: "admin_response".to_string(),
                                                                                    action: "list_all_users".to_string(),
                                                                                    status: "ok".to_string(),
                                                                                    message: Some(format!("Found {} total user(s) in database", total)),
                                                                                    users: Some(users),
                                                                                    total: Some(total),
                                                                                    page: Some(admin_cmd.page),
                                                                                    page_size: Some(admin_cmd.page_size),
                                                                                    ..Default::default()
                                                                                };
                                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                            }
                                                                            Err(e) => {
                                                                                let resp = AdminResponse {
                                                                                    msg_type: "admin_response".to_string(),
                                                                                    action: "list_all_users".to_string(),
                                                                                    status: "error".to_string(),
                                                                                    message: Some(format!("Database query error: {}", e)),
                                                                                    ..Default::default()
                                                                                };
                                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                            }
                                                                        }
                                                                    }
                                                                    Err(e) => {
                                                                        let resp = AdminResponse {
                                                                            msg_type: "admin_response".to_string(),
                                                                            action: "list_all_users".to_string(),
                                                                            status: "error".to_string(),
                                                                            message: Some(format!("Failed to open database: {}", e)),
                                                                            ..Default::default()
                                                                        };
                                                                        ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                    }
                                                                }
                                                            } else {
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "list_all_users".to_string(),
                                                                    status: "error".to_string(),
                                                                    message: Some("Traffic database is not configured".to_string()),
                                                                    ..Default::default()
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            }
                                                        }
                                                        "disconnect_user" => {
                                                            let target_id = admin_cmd.user_id.clone().unwrap_or_default();
                                                            if target_id == user_id {
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "disconnect_user".to_string(),
                                                                    status: "error".to_string(),
                                                                    message: Some("Cannot disconnect yourself".to_string()),
                                                                    users: None,
                                                                    system_info: None,
                                                                    ..Default::default()
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            } else {
                                                                let count = state.disconnect_user_by_id(&target_id);
                                                                if count > 0 {
                                                                    let resp = AdminResponse {
                                                                        msg_type: "admin_response".to_string(),
                                                                        action: "disconnect_user".to_string(),
                                                                        status: "ok".to_string(),
                                                                        message: Some(format!("User {} disconnected ({} session(s))", target_id, count)),
                                                                        users: None,
                                                                        system_info: None,
                                                                        ..Default::default()
                                                                    };
                                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                    println!("Admin {} disconnected user {} ({} session(s))", user_id, target_id, count);
                                                                } else {
                                                                    let resp = AdminResponse {
                                                                        msg_type: "admin_response".to_string(),
                                                                        action: "disconnect_user".to_string(),
                                                                        status: "error".to_string(),
                                                                        message: Some(format!("User {} not found", target_id)),
                                                                        users: None,
                                                                        system_info: None,
                                                                        ..Default::default()
                                                                    };
                                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                }
                                                            }
                                                        }
                                                        "disconnect_session" => {
                                                            let target_user = admin_cmd.user_id.clone().unwrap_or_default();
                                                            let target_session = admin_cmd.session_id.clone().unwrap_or_default();
                                                            if target_session.is_empty() {
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "disconnect_session".to_string(),
                                                                    status: "error".to_string(),
                                                                    message: Some("Missing session_id".to_string()),
                                                                    users: None,
                                                                    system_info: None,
                                                                    ..Default::default()
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            } else if target_user == user_id && target_session == session_id {
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "disconnect_session".to_string(),
                                                                    status: "error".to_string(),
                                                                    message: Some("Cannot disconnect yourself".to_string()),
                                                                    users: None,
                                                                    system_info: None,
                                                                    ..Default::default()
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            } else {
                                                                let found = state.disconnect_session(&target_user, &target_session);
                                                                if found {
                                                                    let resp = AdminResponse {
                                                                        msg_type: "admin_response".to_string(),
                                                                        action: "disconnect_session".to_string(),
                                                                        status: "ok".to_string(),
                                                                        message: Some(format!("Session {} disconnected for user {}", target_session, target_user)),
                                                                        users: None,
                                                                        system_info: None,
                                                                        ..Default::default()
                                                                    };
                                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                    println!("Admin {} disconnected session {} of user {}", user_id, target_session, target_user);
                                                                } else {
                                                                    let resp = AdminResponse {
                                                                        msg_type: "admin_response".to_string(),
                                                                        action: "disconnect_session".to_string(),
                                                                        status: "error".to_string(),
                                                                        message: Some(format!("Session {} not found for user {}", target_session, target_user)),
                                                                        users: None,
                                                                        system_info: None,
                                                                        ..Default::default()
                                                                    };
                                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                }
                                                            }
                                                        }
                                                        "get_system_info" => {
                                                            let info = collect_system_info();
                                                            let resp = AdminResponse {
                                                                msg_type: "admin_response".to_string(),
                                                                action: "get_system_info".to_string(),
                                                                status: "ok".to_string(),
                                                                message: Some("System info collected".to_string()),
                                                                users: None,
                                                                system_info: Some(info),
                                                                ..Default::default()
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        }
                                                        "get_traffic_stats" => {
                                                            let traffic_resp = state.traffic.lock().unwrap().build_response(admin_cmd.limit);
                                                            let resp = AdminResponse {
                                                                msg_type: "admin_response".to_string(),
                                                                action: "get_traffic_stats".to_string(),
                                                                status: "ok".to_string(),
                                                                message: Some(format!("Traffic stats: {} active session(s)", traffic_resp.users.len())),
                                                                traffic: Some(serde_json::to_value(traffic_resp).unwrap_or_default()),
                                                                ..Default::default()
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        }
                                                        "get_traffic_history" => {
                                                            let to_ms = traffic::now_ms() as i64;
                                                            // from_ms 由客户端明确传入；不传则默认查最近 1 小时
                                                            let from_ms = admin_cmd.from_ms.unwrap_or(to_ms - 3600_000);
                                                            let db_path = state.config.traffic_db_path.clone();
                                                            let (history_result, total, total_inbound, total_outbound, total_relay, total_handshake) = if let Some(ref path) = db_path {
                                                                match rusqlite::Connection::open(path) {
                                                                    Ok(conn) => {
                                                                        let history = match traffic::query_traffic_history_paginated(
                                                                            &conn,
                                                                            from_ms,
                                                                            to_ms,
                                                                            admin_cmd.user_id.as_deref(),
                                                                            admin_cmd.page,
                                                                            admin_cmd.page_size,
                                                                        ) {
                                                                            Ok((rows, total)) => (rows, total),
                                                                            Err(e) => (
                                                                                vec![serde_json::json!({"error": format!("Query failed: {}", e)})],
                                                                                0,
                                                                            ),
                                                                        };
                                                                        let totals = traffic::query_traffic_history_totals(
                                                                            &conn,
                                                                            from_ms,
                                                                            to_ms,
                                                                            admin_cmd.user_id.as_deref(),
                                                                        ).unwrap_or((0, 0, 0, 0));
                                                                        (history.0, history.1, totals.0, totals.1, totals.2, totals.3)
                                                                    }
                                                                    Err(e) => (
                                                                        vec![serde_json::json!({"error": format!("Failed to open DB: {}", e)})],
                                                                        0, 0, 0, 0, 0,
                                                                    ),
                                                                }
                                                            } else {
                                                                (Vec::new(), 0, 0, 0, 0, 0)
                                                            };
                                                            let resp = AdminResponse {
                                                                msg_type: "admin_response".to_string(),
                                                                action: "get_traffic_history".to_string(),
                                                                status: "ok".to_string(),
                                                                message: Some(format!("Found {} history record(s) in range [{} ~ {}]", history_result.len(), from_ms, to_ms)),
                                                                history: Some(history_result),
                                                                total: Some(total),
                                                                page: Some(admin_cmd.page),
                                                                page_size: Some(admin_cmd.page_size),
                                                                total_inbound_bytes: Some(total_inbound),
                                                                total_outbound_bytes: Some(total_outbound),
                                                                total_relay_forwarded_bytes: Some(total_relay),
                                                                total_handshake_bytes: Some(total_handshake),
                                                                ..Default::default()
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        }
                                                        "get_system_stats_history" => {
                                                            let limit = admin_cmd.limit.unwrap_or(60);
                                                            let db_path = state.config.traffic_db_path.clone();
                                                            let stats_result: Vec<serde_json::Value> = if let Some(ref path) = db_path {
                                                                match rusqlite::Connection::open(path) {
                                                                    Ok(conn) => {
                                                                        match traffic::query_system_stats_history(&conn, limit) {
                                                                            Ok(rows) => rows.iter().map(|r| serde_json::json!({
                                                                                "recordedAt": r.recorded_at,
                                                                                "cpuUsagePercent": r.cpu_usage_percent,
                                                                                "memoryUsagePercent": r.memory_usage_percent,
                                                                            })).collect(),
                                                                            Err(e) => {
                                                                                vec![serde_json::json!({"error": format!("Query failed: {}", e)})]
                                                                            }
                                                                        }
                                                                    }
                                                                    Err(e) => {
                                                                        vec![serde_json::json!({"error": format!("Failed to open DB: {}", e)})]
                                                                    }
                                                                }
                                                            } else {
                                                                Vec::new()
                                                            };
                                                            let resp = AdminResponse {
                                                                msg_type: "admin_response".to_string(),
                                                                action: "get_system_stats_history".to_string(),
                                                                status: "ok".to_string(),
                                                                message: Some(format!("Found {} system stats record(s)", stats_result.len())),
                                                                system_stats: Some(stats_result),
                                                                ..Default::default()
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        }
                                                        "set_user_relay_quota" => {
                                                            let target_user = admin_cmd.user_id.clone().unwrap_or_default();
                                                            if target_user.is_empty() {
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "set_user_relay_quota".to_string(),
                                                                    status: "error".to_string(),
                                                                    message: Some("Missing user_id".to_string()),
                                                                    ..Default::default()
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            } else if let Some(quota_bytes) = admin_cmd.quota_bytes {
                                                                let quota = state.set_user_relay_quota(&target_user, quota_bytes);
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "set_user_relay_quota".to_string(),
                                                                    status: "ok".to_string(),
                                                                    message: Some(format!("User {} relay quota set to {} bytes", target_user, quota_bytes)),
                                                                    quota: Some(serde_json::to_value(quota).unwrap_or_default()),
                                                                    ..Default::default()
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                println!("Admin {} set user {} relay quota to {} bytes", user_id, target_user, quota_bytes);
                                                            } else {
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "set_user_relay_quota".to_string(),
                                                                    status: "error".to_string(),
                                                                    message: Some("Missing quota_bytes".to_string()),
                                                                    ..Default::default()
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            }
                                                        }
                                                        "get_user_relay_quota" => {
                                                            if let Some(user_ids) = admin_cmd.user_ids {
                                                                let mut quotas = Vec::new();
                                                                for tid in user_ids {
                                                                    let q = state.get_or_create_user_quota(&tid);
                                                                    quotas.push(serde_json::to_value(q).unwrap_or_default());
                                                                }
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "get_user_relay_quota".to_string(),
                                                                    status: "ok".to_string(),
                                                                    message: Some(format!("Fetched {} user relay quota(s)", quotas.len())),
                                                                    quotas: Some(quotas),
                                                                    ..Default::default()
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            } else {
                                                                let target_user = admin_cmd.user_id.clone().unwrap_or_default();
                                                                if target_user.is_empty() {
                                                                    let resp = AdminResponse {
                                                                        msg_type: "admin_response".to_string(),
                                                                        action: "get_user_relay_quota".to_string(),
                                                                        status: "error".to_string(),
                                                                        message: Some("Missing user_id or user_ids".to_string()),
                                                                        ..Default::default()
                                                                    };
                                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                } else {
                                                                    let quota = state.get_or_create_user_quota(&target_user);
                                                                    let resp = AdminResponse {
                                                                        msg_type: "admin_response".to_string(),
                                                                        action: "get_user_relay_quota".to_string(),
                                                                        status: "ok".to_string(),
                                                                        message: Some(format!("User {} relay quota", target_user)),
                                                                        quota: Some(serde_json::to_value(quota).unwrap_or_default()),
                                                                        ..Default::default()
                                                                    };
                                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                }
                                                            }
                                                        }
                                                        _ => {
                                                            let action_name = admin_cmd.action.clone();
                                                            let resp = AdminResponse {
                                                                msg_type: "admin_response".to_string(),
                                                                action: admin_cmd.action,
                                                                status: "error".to_string(),
                                                                message: Some(format!("Unknown admin action: {}", action_name)),
                                                                users: None,
                                                                system_info: None,
                                                                ..Default::default()
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        }
                                                    }
                                                    continue;
                                                }
                                            }

                                            // 处理查询命令：查询用户是否在线
                                            if msg_type == "query" {
                                                let action = cmd.get("action").and_then(|v| v.as_str()).unwrap_or("");
                                                if action == "user_online" {
                                                    let target_user_id = cmd.get("user_id").and_then(|v| v.as_str()).unwrap_or("");
                                                    if target_user_id.is_empty() {
                                                        let resp = serde_json::json!({
                                                            "type": "query_response",
                                                            "action": "user_online",
                                                            "status": "error",
                                                            "message": "Missing user_id"
                                                        });
                                                        ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                    } else {
                                                        let session_info = state.get_user_sessions_with_latency(target_user_id);
                                                        let online = !session_info.is_empty();
                                                        let sessions: Vec<String> = session_info.iter()
                                                            .filter_map(|s| s["sessionId"].as_str().map(String::from))
                                                            .collect();
                                                        let resp = serde_json::json!({
                                                            "type": "query_response",
                                                            "action": "user_online",
                                                            "status": "ok",
                                                            "online": online,
                                                            "sessions": sessions,
                                                            "sessionInfo": session_info
                                                        });
                                                        ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                    }
                                                    continue;
                                                }
                                                // 未知 query action
                                                let resp = serde_json::json!({
                                                    "type": "query_response",
                                                    "action": action,
                                                    "status": "error",
                                                    "message": format!("Unknown query action: {}", action)
                                                });
                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                continue;
                                            }

                                            // 处理 relay 命令：转发数据到指定用户 session
                                            if msg_type == "relay" {
                                                let action = cmd.get("action").and_then(|v| v.as_str()).unwrap_or("");
                                                if action == "send_data" {
                                                    let target_user = cmd.get("target_user_id").and_then(|v| v.as_str()).unwrap_or("");
                                                    let target_session = cmd.get("target_session_id").and_then(|v| v.as_str()).unwrap_or("");
                                                    let relay_data = cmd.get("data");

                                                    if target_user.is_empty() || target_session.is_empty() || relay_data.is_none() {
                                                        let resp = serde_json::json!({
                                                            "type": "relay_response",
                                                            "action": "send_data",
                                                            "status": "error",
                                                            "message": "Missing target_user_id, target_session_id, or data"
                                                        });
                                                        ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                    } else {
                                                        // 构造要转发给目标的消息
                                                        let forward_msg = serde_json::json!({
                                                            "type": "relay",
                                                            "from_user_id": user_id,
                                                            "from_session_id": session_id,
                                                            "data": relay_data
                                                        });
                                                        let forward_text = serde_json::to_string(&forward_msg)?;
                                                        let forward_text_len = forward_text.len() as u64;

                                                        // 检查转发额度
                                                        if !state.check_relay_quota(&user_id, forward_text_len) {
                                                            let resp = serde_json::json!({
                                                                "type": "relay_response",
                                                                "action": "send_data",
                                                                "status": "quota_exceeded",
                                                                "message": format!("Relay quota exceeded: used {} / {} bytes, only messages <= {} bytes are allowed", state.get_or_create_user_quota(&user_id).used_bytes, state.get_or_create_user_quota(&user_id).quota_bytes, state.config.relay_small_message_max_bytes)
                                                            });
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            continue;
                                                        }

                                                        // 获取目标的 data_tx 并发送
                                                        let delivered = if let Some(tx) = state.get_session_data_tx(target_user, target_session) {
                                                            tx.send(Message::Text(forward_text)).is_ok()
                                                        } else {
                                                            false
                                                        };

                                                        if delivered {
                                                            // 统计转发流量（计入源连接）并记录额度用量
                                                            {
                                                                state.traffic.lock().unwrap().add_relay_forwarded(&conn_key, forward_text_len, traffic::now_ms());
                                                            }
                                                            state.record_relay_usage(&user_id, forward_text_len);
                                                            let resp = serde_json::json!({
                                                                "type": "relay_response",
                                                                "action": "send_data",
                                                                "status": "ok",
                                                                "message": "Data delivered to target"
                                                            });
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            println!("Relay: {}:{} -> {}:{}", user_id, session_id, target_user, target_session);
                                                            // relay 成功：重置失败计数
                                                            state.reset_relay_failure(&conn_key);
                                                        } else {
                                                            println!("Relay failed (target offline): {}:{} -> {}:{}", user_id, session_id, target_user, target_session);
                                                            let resp = serde_json::json!({
                                                                "type": "relay_response",
                                                                "action": "send_data",
                                                                "status": "error",
                                                                "message": "Target session not found or offline"
                                                            });
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            // 中继风暴防护：累计失败次数，达到阈值时踢出该连接
                                                            let should_kick = state.handle_relay_failure(&user_id, &session_id);
                                                            if should_kick {
                                                                println!("User {}:{} kicked due to relay abuse ({} failures within {}s)", user_id, session_id, state.config.relay_fail_limit, state.config.relay_fail_window_secs);
                                                                let _ = ws_sender.send(Message::Close(None)).await;
                                                                break;
                                                            }
                                                        }
                                                    }
                                                    continue;
                                                }
                                                // 未知 relay action
                                                let resp = serde_json::json!({
                                                    "type": "relay_response",
                                                    "action": action,
                                                    "status": "error",
                                                    "message": format!("Unknown relay action: {}", action)
                                                });
                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                continue;
                                            }

                                            // 处理 latency_test 命令：测量客户端到服务器的延迟
                                            if msg_type == "latency_test" {
                                                let client_time = cmd.get("client_time").and_then(|v| v.as_u64()).unwrap_or(0);
                                                let now_ms = std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH)
                                                    .unwrap_or_default()
                                                    .as_millis() as u64;
                                                let resp = serde_json::json!({
                                                    "type": "latency_test_response",
                                                    "client_time": client_time,
                                                    "server_recv_time": now_ms,
                                                    "server_send_time": now_ms
                                                });
                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                continue;
                                            }

                                            // 处理 latency_report：客户端报告完整的延迟数据，服务器据此计算自身的延迟认知
                                            if msg_type == "latency_report" {
                                                let client_time = cmd.get("client_time").and_then(|v| v.as_u64()).unwrap_or(0);
                                                let _server_recv_time = cmd.get("server_recv_time").and_then(|v| v.as_u64()).unwrap_or(0);
                                                let _server_send_time = cmd.get("server_send_time").and_then(|v| v.as_u64()).unwrap_or(0);
                                                let client_recv_time = cmd.get("client_recv_time").and_then(|v| v.as_u64()).unwrap_or(0);

                                                let rtt = if client_time > 0 && client_recv_time > client_time {
                                                    client_recv_time - client_time
                                                } else {
                                                    0
                                                };
                                                if rtt > 0 {
                                                    let one_way_ms = rtt / 2;
                                                    println!("Latency measurement complete: {}:{} ({}) — RTT: {}ms, one-way: ~{}ms", user_id, session_id, username, rtt, one_way_ms);
                                                    // 保存延迟到状态
                                                    state.update_latency(&user_id, &session_id, rtt);
                                                }

                                                let now_ms = std::time::SystemTime::now()
                                                    .duration_since(std::time::UNIX_EPOCH)
                                                    .unwrap_or_default()
                                                    .as_millis() as u64;
                                                let ack = serde_json::json!({
                                                    "type": "latency_report_ack",
                                                    "server_recv_time": now_ms,
                                                    "status": "ok"
                                                });
                                                ws_sender.send(Message::Text(serde_json::to_string(&ack)?)).await?;
                                                continue;
                                            }
                                        }

                                        // 忽略未知类型的消息
                                    }
                                    Message::Binary(data) => {
                                        // 统计入站流量（不论消息大小）
                                        {
                                            state.traffic.lock().unwrap().add_inbound(&conn_key, data.len() as u64, traffic::now_ms());
                                        }

                                        // 检查二进制消息总大小
                                        let binary_max_size = state.config.binary_payload_max_size;
                                        let total_binary_max = binary_max_size + 4096; // payload + header 开销
                                        if data.len() > total_binary_max {
                                            println!("Oversized binary message ({} bytes) from {}:{} ({}), rejected", data.len(), user_id, session_id, username);
                                            let resp = serde_json::json!({
                                                "type": "relay_response",
                                                "action": "send_data",
                                                "status": "error",
                                                "message": format!("Binary message too large: {} bytes (max {} bytes)", data.len(), total_binary_max)
                                            });
                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                            continue;
                                        }

                                        // 解析二进制 relay 帧：[4 字节 header JSON 长度 u32 BE] + [header JSON bytes] + [原始 payload]
                                        if data.len() < 4 {
                                            let resp = serde_json::json!({
                                                "type": "relay_response",
                                                "action": "send_data",
                                                "status": "error",
                                                "message": "Invalid binary relay frame: too short"
                                            });
                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                            continue;
                                        }

                                        let header_len = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
                                        if header_len > data.len() - 4 {
                                            let resp = serde_json::json!({
                                                "type": "relay_response",
                                                "action": "send_data",
                                                "status": "error",
                                                "message": "Invalid binary relay frame: header length out of bounds"
                                            });
                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                            continue;
                                        }

                                        let header: serde_json::Value = match serde_json::from_slice(&data[4..4 + header_len]) {
                                            Ok(v) => v,
                                            Err(_) => {
                                                let resp = serde_json::json!({
                                                    "type": "relay_response",
                                                    "action": "send_data",
                                                    "status": "error",
                                                    "message": "Invalid binary relay frame: header JSON parse failed"
                                                });
                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                continue;
                                            }
                                        };

                                        let msg_type = header.get("type").and_then(|v| v.as_str()).unwrap_or("");
                                        let action = header.get("action").and_then(|v| v.as_str()).unwrap_or("");

                                        if msg_type == "relay" && action == "send_data" {
                                            let target_user = header.get("target_user_id").and_then(|v| v.as_str()).unwrap_or("");
                                            let target_session = header.get("target_session_id").and_then(|v| v.as_str()).unwrap_or("");

                                            if target_user.is_empty() || target_session.is_empty() {
                                                let resp = serde_json::json!({
                                                    "type": "relay_response",
                                                    "action": "send_data",
                                                    "status": "error",
                                                    "message": "Missing target_user_id or target_session_id"
                                                });
                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                            } else {
                                                let payload = &data[4 + header_len..];

                                                // 检查 relay 负载大小
                                                if payload.len() > binary_max_size {
                                                    let resp = serde_json::json!({
                                                        "type": "relay_response",
                                                        "action": "send_data",
                                                        "status": "error",
                                                        "message": format!("Relay payload too large: {} bytes (max {} bytes)", payload.len(), binary_max_size)
                                                    });
                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                    continue;
                                                }

                                                let forward_header = serde_json::json!({
                                                    "type": "relay",
                                                    "from_user_id": user_id,
                                                    "from_session_id": session_id,
                                                });
                                                let forward_header_bytes = serde_json::to_vec(&forward_header)?;
                                                let forward_header_len = forward_header_bytes.len() as u32;

                                                let mut forward_frame = Vec::with_capacity(4 + forward_header_bytes.len() + payload.len());
                                                forward_frame.extend_from_slice(&forward_header_len.to_be_bytes());
                                                forward_frame.extend_from_slice(&forward_header_bytes);
                                                forward_frame.extend_from_slice(payload);
                                                let forward_frame_size = forward_frame.len() as u64;

                                                // 检查转发额度
                                                if !state.check_relay_quota(&user_id, forward_frame_size) {
                                                    let resp = serde_json::json!({
                                                        "type": "relay_response",
                                                        "action": "send_data",
                                                        "status": "quota_exceeded",
                                                        "message": format!("Relay quota exceeded: used {} / {} bytes, only messages <= {} bytes are allowed", state.get_or_create_user_quota(&user_id).used_bytes, state.get_or_create_user_quota(&user_id).quota_bytes, state.config.relay_small_message_max_bytes)
                                                    });
                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                    continue;
                                                }

                                                let delivered = if let Some(tx) = state.get_session_data_tx(target_user, target_session) {
                                                    tx.send(Message::Binary(forward_frame)).is_ok()
                                                } else {
                                                    false
                                                };

                                                if delivered {
                                                    // 统计转发流量（计入源连接）并记录额度用量
                                                    {
                                                        state.traffic.lock().unwrap().add_relay_forwarded(&conn_key, forward_frame_size, traffic::now_ms());
                                                    }
                                                    state.record_relay_usage(&user_id, forward_frame_size);
                                                    let resp = serde_json::json!({
                                                        "type": "relay_response",
                                                        "action": "send_data",
                                                        "status": "ok",
                                                        "message": "Binary data delivered to target"
                                                    });
                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                    println!("Binary relay: {}:{} -> {}:{}", user_id, session_id, target_user, target_session);
                                                    // relay 成功：重置失败计数
                                                    state.reset_relay_failure(&conn_key);
                                                } else {
                                                    println!("Binary relay failed (target offline): {}:{} -> {}:{}", user_id, session_id, target_user, target_session);
                                                    let resp = serde_json::json!({
                                                        "type": "relay_response",
                                                        "action": "send_data",
                                                        "status": "error",
                                                        "message": "Target session not found or offline"
                                                    });
                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                    // 中继风暴防护：累计失败次数，达到阈值时踢出该连接
                                                    let should_kick = state.handle_relay_failure(&user_id, &session_id);
                                                    if should_kick {
                                                        println!("User {}:{} kicked due to relay abuse ({} failures within {}s)", user_id, session_id, state.config.relay_fail_limit, state.config.relay_fail_window_secs);
                                                        let _ = ws_sender.send(Message::Close(None)).await;
                                                        break;
                                                    }
                                                }
                                            }
                                        } else {
                                            // 非 relay 二进制帧保持原样回显
                                            ws_sender.send(Message::Binary(data)).await?;
                                        }
                                    }
                                    Message::Ping(data) => {
                                        ws_sender.send(Message::Pong(data)).await?;
                                    }
                                    Message::Pong(_) => {}
                                    Message::Close(_) => {
                                        println!("Connection closed by client: {}:{} ({})", user_id, session_id, addr);
                                        break;
                                    }
                                    Message::Frame(_) => {}
                                }
                            }
                            Some(Err(e)) => {
                                eprintln!("WebSocket error for {}:{} ({}): {}", user_id, session_id, addr, e);
                                break;
                            }
                            None => break,
                        }
                    }
                }
            }

            // 9. 清理：连接关闭后从状态中移除用户和流量计数，并保存额度快照
            {
                state.remove_user(&conn_key);
                if let Some(session) = state.traffic.lock().unwrap().remove_session(&conn_key) {
                    // 最终落盘：确保即使是短连接也会被持久化
                    traffic::save_final_session_stats(&state.config.traffic_db_path, &session);
                }
                if let Some(quota) = state.user_quotas.get(&user_id) {
                    traffic::save_final_user_quota(&state.config.traffic_db_path, &quota);
                }
            }
            println!("User {}:{} ({}) removed from state and traffic stats", user_id, session_id, username);
        }
        Err(e) => {
            eprintln!("Handshake: User {}:{} authentication FAILED: {}", user_id, session_id, e);
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: format!("Verification failed: {}", e),
                is_admin: None,
                version: None,
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            let _ = ws_sender.send(Message::Close(None)).await;
            return Err(format!("Handshake failed: {}", e).into());
        }
    }

    Ok(())
}
