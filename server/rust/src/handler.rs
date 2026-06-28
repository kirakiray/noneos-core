use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, mpsc};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{accept_hdr_async, tungstenite::{protocol::Message, handshake::server::{Request, Response, ErrorResponse}}};
use serde::Serialize;
use crate::crypto::verify_signature;
use crate::config::Config;
use crate::traffic;
use rand::{thread_rng, Rng};
use rand::distributions::Alphanumeric;

use dashmap::DashMap;
use crate::admin;
use redb::Database;

/// 挑战信息格式
#[derive(Serialize)]
pub struct HandshakeChallenge {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub challenge: String,
}

/// 已连接用户的信息
pub(crate) struct UserSession {
    pub(crate) username: String,
    pub(crate) host: String,
    pub(crate) addr: SocketAddr,
    pub(crate) disconnect_tx: Option<oneshot::Sender<()>>,
    pub(crate) data_tx: mpsc::UnboundedSender<Message>, // 用于转发消息的目标通道
    pub(crate) latency_ms: Option<u64>,                  // 最近一次延迟测量的 RTT（毫秒）
    pub(crate) connected_at: u64,                        // 连接建立时的 Unix 时间戳（毫秒）
    /// 当前 relay 失败计数窗口内，已发生 relay 到不存在 session 的次数
    pub(crate) relay_fail_count: u32,
    /// relay 失败计数窗口开始时间（Unix 毫秒）
    pub(crate) relay_fail_window_start: u64,
    /// 该 session 公开注册的应用服务列表（exposeToServer 模式）
    pub(crate) services: Vec<String>,
}

/// 应用共享状态，存储所有已连接用户和管理员配置
/// 用户以 "userId:sessionId" 为 key 存储，同一 userId 的不同 sessionId 可同时连接
pub struct AppState {
    pub admin_user_id: Option<String>,
    pub config: Config,
    pub traffic: std::sync::Mutex<traffic::TrafficStats>,
    pub user_quotas: DashMap<String, traffic::UserRecord>,
    pub db: Arc<Database>,
    pub(crate) users: DashMap<String, UserSession>,
    /// 用户当前 session 计数：userId -> count
    pub(crate) user_session_counts: DashMap<String, usize>,
}

impl AppState {
    pub fn new(admin_user_id: Option<String>, config: Config, db: Arc<Database>) -> Self {
        Self {
            admin_user_id: admin_user_id.clone(),
            traffic: std::sync::Mutex::new(traffic::TrafficStats::new(60)),
            config,
            users: DashMap::new(),
            user_quotas: DashMap::new(),
            user_session_counts: DashMap::new(),
            db,
        }
    }

    /// 判断指定用户是否为管理员
    pub fn is_admin(&self, user_id: &str) -> bool {
        self.admin_user_id.as_deref() == Some(user_id)
    }

    /// 获取或创建用户的转发额度（内存中）
    pub fn get_or_create_user_quota(&self, user_id: &str) -> traffic::UserRecord {
        if let Some(q) = self.user_quotas.get(user_id) {
            return q.clone();
        }
        let now = traffic::now_ms();
        // 尝试从 redb 加载
        let record = traffic::load_user(&self.db, user_id).ok().flatten().unwrap_or_else(|| traffic::UserRecord {
            user_id: user_id.to_string(),
            username: String::new(),
            public_key: String::new(),
            first_seen_at: now,
            last_seen_at: now,
            quota_bytes: self.config.default_relay_quota_bytes,
            used_bytes: 0,
        });
        self.user_quotas.insert(user_id.to_string(), record.clone());
        record
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
                q.last_seen_at = now;
            })
            .or_insert_with(|| traffic::UserRecord {
                user_id: user_id.to_string(),
                username: String::new(),
                public_key: String::new(),
                first_seen_at: now,
                last_seen_at: now,
                quota_bytes: self.config.default_relay_quota_bytes,
                used_bytes: bytes,
            });
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
            // 注意：这里不需要减少计数，因为马上会增加或在 Error 时由 remove_user 处理
            // 实际上 remove 会减少计数，所以这里要小心
            self.user_session_counts.entry(user_id.clone()).and_modify(|c| *c = c.saturating_sub(1));
        }

        // 检查该 userId 的当前 session 数 (O(1) 复杂度)
        let current_count = self.user_session_counts.get(&user_id).map(|c| *c).unwrap_or(0);
        
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
            services: Vec::new(),
        });
        
        // 增加计数
        self.user_session_counts.entry(user_id).and_modify(|c| *c += 1).or_insert(1);
        
        Ok(())
    }

    pub fn remove_user(&self, conn_key: &str) -> Option<UserSession> {
        if let Some((_, session)) = self.users.remove(conn_key) {
            let user_id = conn_key.split(':').next().unwrap_or(conn_key);
            self.user_session_counts.entry(user_id.to_string()).and_modify(|c| *c = c.saturating_sub(1));
            Some(session)
        } else {
            None
        }
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
                    "services": session.services,
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

    /// 更新指定 session 的公开服务列表（exposeToServer 模式）
    pub fn update_services(&self, user_id: &str, session_id: &str, services: Vec<String>) {
        let conn_key = format!("{}:{}", user_id, session_id);
        if let Some(mut session) = self.users.get_mut(&conn_key) {
            session.services = services;
        }
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

/// 核心业务函数：处理单个 WebSocket 连接的完整生命周期
#[allow(clippy::result_large_err)]
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
                let mem_usage = admin::get_memory_usage_percent().await;
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
                let mut tr = state.traffic.lock().unwrap_or_else(|e| e.into_inner());
                let now_ms = traffic::now_ms();
                tr.register_session(&conn_key, &user_id, &session_id, &username, now_ms);
                tr.add_handshake(&conn_key, handshake_size as u64, now_ms);
            }

            // 持久化用户信息到 redb（单 key 写入，直接同步）
            {
                let now = traffic::now_ms();
                let record = traffic::UserRecord {
                    user_id: user_id.clone(),
                    username: username.clone(),
                    public_key: public_key.clone(),
                    first_seen_at: now,
                    last_seen_at: now,
                    quota_bytes: state.config.default_relay_quota_bytes,
                    used_bytes: 0,
                };
                if let Err(e) = traffic::save_user(&state.db, &record) {
                    eprintln!("Failed to persist user {} to redb: {}", user_id, e);
                }
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

            // 8. 通信循环（包裹在 Result 块中，确保 ? 不会跳过清理代码）
            let comm_result: std::result::Result<(), Box<dyn std::error::Error + Send + Sync>> = async {
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
                                state.traffic.lock().unwrap_or_else(|e| e.into_inner()).add_outbound(&conn_key, out_size, traffic::now_ms());
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
                                                state.traffic.lock().unwrap_or_else(|e| e.into_inner()).add_inbound(&conn_key, text.len() as u64, traffic::now_ms());
                                            }

                                            // 尝试解析为 JSON 命令
                                            if let Ok(cmd) = serde_json::from_str::<serde_json::Value>(&text) {
                                                let msg_type = cmd.get("type").and_then(|v| v.as_str()).unwrap_or("");

                                                // 处理管理命令
                                                if msg_type == "admin" {
                                                    if let Ok(admin_cmd) = serde_json::from_str::<admin::AdminCommand>(&text) {
                                                        if !is_admin {
                                                            let resp = admin::AdminResponse {
                                                                msg_type: "admin_response".to_string(),
                                                                action: admin_cmd.action,
                                                                status: "error".to_string(),
                                                                message: Some("Permission denied: not an admin".to_string()),
                                                                ..Default::default()
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            continue;
                                                        }

                                                        let resp = admin::handle_admin_command(&state, admin_cmd, &user_id, &session_id).await;
                                                        ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
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

                                            // 处理 update_services：更新该 session 公开的应用服务列表（exposeToServer 模式）
                                            if msg_type == "update_services" {
                                                let services: Vec<String> = cmd.get("services")
                                                    .and_then(|v| v.as_array())
                                                    .map(|arr| arr.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                                                    .unwrap_or_default();
                                                state.update_services(&user_id, &session_id, services.clone());
                                                if !services.is_empty() {
                                                    println!("Services updated for {}:{} — {:?}", user_id, session_id, services);
                                                }
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
                                                                state.traffic.lock().unwrap_or_else(|e| e.into_inner()).add_relay_forwarded(&conn_key, forward_text_len, traffic::now_ms(), &user_id, target_user);
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
                                            state.traffic.lock().unwrap_or_else(|e| e.into_inner()).add_inbound(&conn_key, data.len() as u64, traffic::now_ms());
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
                                                        state.traffic.lock().unwrap_or_else(|e| e.into_inner()).add_relay_forwarded(&conn_key, forward_frame_size, traffic::now_ms(), &user_id, target_user);
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
                Ok(())
            }.await;

            // 9. 无论通信循环是否出错，始终执行清理
            {
                // 移除此用户 session
                state.remove_user(&conn_key);
                // 移除 session 流量统计
                state.traffic.lock().unwrap_or_else(|e| e.into_inner()).remove_session(&conn_key);

                // 检查该用户是否所有 session 都已断开
                let session_count = state.user_session_counts.get(&user_id).map(|c| *c).unwrap_or(0);
                if session_count == 0 {
                    // 所有 session 关闭 → 写入用户流量分布记录 + 持久化配额
                    let now = traffic::now_ms();
                    let ts_30s = now / 30_000;

                    // 取出该用户在当前窗口内的转发分布条目
                    let entries = state.traffic.lock().unwrap_or_else(|e| e.into_inner()).take_user_relay_entries(&user_id);
                    if !entries.is_empty() {
                        if let Err(e) = traffic::write_single_user_traffic_entries(&state.db, ts_30s, &user_id, &entries) {
                            eprintln!("Failed to flush user traffic dist for {} to redb: {}", user_id, e);
                        }
                    }

                    // 持久化用户信息（包含配额用量）
                    if let Some(quota) = state.user_quotas.get(&user_id) {
                        let mut record = quota.clone();
                        record.last_seen_at = now;
                        if let Err(e) = traffic::save_user(&state.db, &record) {
                            eprintln!("Failed to persist user record for {} to redb: {}", user_id, e);
                        }
                    }
                }
            }
            println!("User {}:{} ({}) removed from state and traffic stats", user_id, session_id, username);

            // 如果通信循环因 send 错误提前退出，传播错误
            comm_result?;
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
