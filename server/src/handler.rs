use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, mpsc, Mutex};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{accept_hdr_async, tungstenite::{protocol::Message, handshake::server::{Request, Response, ErrorResponse}}};
use serde::{Deserialize, Serialize};
use crate::crypto::verify_signature;
use rand::{thread_rng, Rng};
use rand::distributions::Alphanumeric;
use sysinfo::{System, Disks};

/// 已连接用户的信息
struct UserSession {
    username: String,
    host: String,
    addr: SocketAddr,
    disconnect_tx: Option<oneshot::Sender<()>>,
    data_tx: mpsc::UnboundedSender<Message>, // 用于转发消息的目标通道
    latency_ms: Option<u64>,                  // 最近一次延迟测量的 RTT（毫秒）
    connected_at: u64,                        // 连接建立时的 Unix 时间戳（毫秒）
}

/// 应用共享状态，存储所有已连接用户和管理员配置
/// 用户以 "userId:sessionId" 为 key 存储，同一 userId 的不同 sessionId 可同时连接
pub struct AppState {
    pub admin_user_id: Option<String>,
    users: HashMap<String, UserSession>,
}

impl AppState {
    pub fn new(admin_user_id: Option<String>) -> Self {
        Self {
            admin_user_id,
            users: HashMap::new(),
        }
    }

    /// 添加用户连接，如果相同的 conn_key 已存在，踢掉旧连接再替换
    fn add_user(&mut self, conn_key: &str, username: &str, host: &str, addr: SocketAddr, disconnect_tx: oneshot::Sender<()>, data_tx: mpsc::UnboundedSender<Message>) {
        // 如果相同 key 已存在，先踢掉旧连接
        if let Some(mut old_session) = self.users.remove(conn_key) {
            if let Some(tx) = old_session.disconnect_tx.take() {
                let _ = tx.send(());
            }
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
        });
    }

    fn remove_user(&mut self, conn_key: &str) -> Option<UserSession> {
        self.users.remove(conn_key)
    }

    /// 根据 userId 踢掉该用户的所有连接（用于管理员断开用户）
    fn disconnect_user_by_id(&mut self, target_user_id: &str) -> usize {
        let prefix = format!("{}:", target_user_id);
        let keys_to_remove: Vec<String> = self.users.keys()
            .filter(|k| k.starts_with(&prefix))
            .cloned()
            .collect();
        let count = keys_to_remove.len();
        for key in keys_to_remove {
            if let Some(mut session) = self.users.remove(&key) {
                if let Some(tx) = session.disconnect_tx.take() {
                    let _ = tx.send(());
                }
            }
        }
        count
    }

    /// 断开指定 session（conn_key = userId:sessionId）
    fn disconnect_session(&mut self, target_user_id: &str, target_session_id: &str) -> bool {
        let conn_key = format!("{}:{}", target_user_id, target_session_id);
        if let Some(mut session) = self.users.remove(&conn_key) {
            if let Some(tx) = session.disconnect_tx.take() {
                let _ = tx.send(());
            }
            true
        } else {
            false
        }
    }

    fn get_all_users(&self) -> Vec<serde_json::Value> {
        self.users.iter().map(|(conn_key, session)| {
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

    /// 查询指定 userId 是否在线，返回所有 sessionId
    fn get_user_sessions(&self, user_id: &str) -> Vec<String> {
        let prefix = format!("{}:", user_id);
        self.users.keys()
            .filter(|k| k.starts_with(&prefix))
            .filter_map(|k| {
                let parts: Vec<&str> = k.splitn(2, ':').collect();
                if parts.len() == 2 { Some(parts[1].to_string()) } else { None }
            })
            .collect()
    }

    /// 获取指定 session 的 data_tx 通道
    fn get_session_data_tx(&self, user_id: &str, session_id: &str) -> Option<mpsc::UnboundedSender<Message>> {
        let conn_key = format!("{}:{}", user_id, session_id);
        self.users.get(&conn_key).map(|s| s.data_tx.clone())
    }

    /// 更新指定 session 的延迟数据
    fn update_latency(&mut self, user_id: &str, session_id: &str, rtt: u64) {
        let conn_key = format!("{}:{}", user_id, session_id);
        if let Some(session) = self.users.get_mut(&conn_key) {
            session.latency_ms = Some(rtt);
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
    session_id: Option<String>,
}

/// 管理命令响应格式
#[derive(Serialize)]
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
}

/// 收集系统信息（内存、CPU、磁盘使用情况）
fn collect_system_info() -> serde_json::Value {
    let mut system = System::new_all();
    system.refresh_memory();
    let disks = Disks::new_with_refreshed_list();

    // 内存信息（字节）
    let total_memory = system.total_memory();
    let used_memory = system.used_memory();
    let available_memory = system.available_memory();

    // CPU 信息（new_all 已加载 CPU 信息）
    let cpu_usage = system.global_cpu_usage();
    let cpu_count = system.cpus().len();

    // 磁盘信息
    let disk_list: Vec<serde_json::Value> = disks.iter().map(|disk| {
        serde_json::json!({
            "mount_point": disk.mount_point().to_string_lossy(),
            "total_space": disk.total_space(),
            "available_space": disk.available_space(),
            "file_system": disk.file_system().to_string_lossy(),
        })
    }).collect();

    serde_json::json!({
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
            "usage_percent": (cpu_usage * 100.0).round() / 100.0,
            "core_count": cpu_count,
        },
        "disks": disk_list,
    })
}

/// 核心业务函数：处理单个 WebSocket 连接的完整生命周期
#[allow(clippy::result_large_err)]
pub async fn handle_connection(
    raw_stream: TcpStream,
    addr: SocketAddr,
    state: Arc<Mutex<AppState>>,
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
        Ok(Some(Ok(Message::Text(text)))) => text,
        Ok(Some(Ok(_))) => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Expected text message during handshake".to_string(),
                is_admin: None,
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

    // 4. 数据解析
    let mut handshake_obj: serde_json::Map<String, serde_json::Value> = match serde_json::from_str(&handshake_data) {
        Ok(serde_json::Value::Object(v)) => v,
        _ => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Invalid JSON format or not an object".to_string(),
                is_admin: None,
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
            let is_admin = {
                let st = state.lock().await;
                st.admin_user_id.as_deref() == Some(&user_id)
            };

            // 创建 disconnect 通道和 data 转发通道并注册用户（以 userId:sessionId 为 key）
            let (disconnect_tx, mut disconnect_rx) = oneshot::channel::<()>();
            let (data_tx, mut data_rx) = mpsc::unbounded_channel::<Message>();
            {
                let mut st = state.lock().await;
                st.add_user(&conn_key, &username, &client_origin, addr, disconnect_tx, data_tx);
            }

            let role_str = if is_admin { " (ADMIN)" } else { "" };
            println!("Handshake: User {}:{} ({}) authenticated successfully{}", user_id, session_id, username, role_str);

            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "success".to_string(),
                message: "Authentication successful".to_string(),
                is_admin: Some(is_admin),
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
                        ws_sender.send(forward_msg).await?;
                    }
                    // 接收客户端消息
                    msg = ws_receiver.next() => {
                        match msg {
                            Some(Ok(msg)) => {
                                match msg {
                                    Message::Text(text) => {
                                        println!("Message from {}:{} ({}){}: {}", user_id, session_id, username, role_str, text);

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
                                                        };
                                                        ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        continue;
                                                    }

                                                    match admin_cmd.action.as_str() {
                                                        "list_users" => {
                                                            let users = {
                                                                let st = state.lock().await;
                                                                st.get_all_users()
                                                            };
                                                            let count = users.len();
                                                            let resp = AdminResponse {
                                                                msg_type: "admin_response".to_string(),
                                                                action: "list_users".to_string(),
                                                                status: "ok".to_string(),
                                                                message: Some(format!("{} user(s) connected", count)),
                                                                users: Some(users),
                                                                system_info: None,
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
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
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            } else {
                                                                let count = {
                                                                    let mut st = state.lock().await;
                                                                    st.disconnect_user_by_id(&target_id)
                                                                };
                                                                if count > 0 {
                                                                    let resp = AdminResponse {
                                                                        msg_type: "admin_response".to_string(),
                                                                        action: "disconnect_user".to_string(),
                                                                        status: "ok".to_string(),
                                                                        message: Some(format!("User {} disconnected ({} session(s))", target_id, count)),
                                                                        users: None,
                                                                        system_info: None,
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
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            } else {
                                                                let found = {
                                                                    let mut st = state.lock().await;
                                                                    st.disconnect_session(&target_user, &target_session)
                                                                };
                                                                if found {
                                                                    let resp = AdminResponse {
                                                                        msg_type: "admin_response".to_string(),
                                                                        action: "disconnect_session".to_string(),
                                                                        status: "ok".to_string(),
                                                                        message: Some(format!("Session {} disconnected for user {}", target_session, target_user)),
                                                                        users: None,
                                                                        system_info: None,
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
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
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
                                                        let sessions = {
                                                            let st = state.lock().await;
                                                            st.get_user_sessions(target_user_id)
                                                        };
                                                        let online = !sessions.is_empty();
                                                        let resp = serde_json::json!({
                                                            "type": "query_response",
                                                            "action": "user_online",
                                                            "status": "ok",
                                                            "online": online,
                                                            "sessions": sessions
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

                                                        // 获取目标的 data_tx 并发送
                                                        let delivered = {
                                                            let st = state.lock().await;
                                                            if let Some(tx) = st.get_session_data_tx(target_user, target_session) {
                                                                tx.send(Message::Text(forward_text)).is_ok()
                                                            } else {
                                                                false
                                                            }
                                                        };

                                                        if delivered {
                                                            let resp = serde_json::json!({
                                                                "type": "relay_response",
                                                                "action": "send_data",
                                                                "status": "ok",
                                                                "message": "Data delivered to target"
                                                            });
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            println!("Relay: {}:{} -> {}:{}", user_id, session_id, target_user, target_session);
                                                        } else {
                                                            let resp = serde_json::json!({
                                                                "type": "relay_response",
                                                                "action": "send_data",
                                                                "status": "error",
                                                                "message": "Target session not found or offline"
                                                            });
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
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
                                                    let mut st = state.lock().await;
                                                    st.update_latency(&user_id, &session_id, rtt);
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

                                        // 非管理/查询/relay/latency 命令：回显
                                        // 限制纯文本回声的大小不超过 100 字节
                                        if text.len() > 100 {
                                            let err_msg = serde_json::json!({
                                                "type": "echo_error",
                                                "status": "error",
                                                "message": format!("Echo rejected: payload too large ({} bytes, max 100)", text.len())
                                            });
                                            ws_sender.send(Message::Text(serde_json::to_string(&err_msg)?)).await?;
                                            let _ = ws_sender.send(Message::Close(None)).await;
                                            println!("Disconnected {}:{} ({}): payload too large ({} bytes)", user_id, session_id, username, text.len());
                                            break;
                                        }
                                        let response = format!("Server received: {}", text);
                                        ws_sender.send(Message::Text(response)).await?;
                                    }
                                    Message::Binary(data) => {
                                        ws_sender.send(Message::Binary(data)).await?;
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

            // 9. 清理：连接关闭后从状态中移除用户
            {
                let mut st = state.lock().await;
                st.remove_user(&conn_key);
            }
            println!("User {}:{} ({}) removed from state", user_id, session_id, username);
        }
        Err(e) => {
            eprintln!("Handshake: User {}:{} authentication FAILED: {}", user_id, session_id, e);
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: format!("Verification failed: {}", e),
                is_admin: None,
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            let _ = ws_sender.send(Message::Close(None)).await;
            return Err(format!("Handshake failed: {}", e).into());
        }
    }

    Ok(())
}
