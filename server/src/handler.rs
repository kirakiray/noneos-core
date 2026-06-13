use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};
use serde::{Deserialize, Serialize};
use crate::crypto::verify_signature;
use rand::{thread_rng, Rng};
use rand::distributions::Alphanumeric;
use sysinfo::{System, Disks};

/// 已连接用户的信息
struct UserSession {
    username: String,
    addr: SocketAddr,
    disconnect_tx: Option<oneshot::Sender<()>>,
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
    fn add_user(&mut self, conn_key: &str, username: &str, addr: SocketAddr, disconnect_tx: oneshot::Sender<()>) {
        // 如果相同 key 已存在，先踢掉旧连接
        if let Some(mut old_session) = self.users.remove(conn_key) {
            if let Some(tx) = old_session.disconnect_tx.take() {
                let _ = tx.send(());
            }
        }
        self.users.insert(conn_key.to_string(), UserSession {
            username: username.to_string(),
            addr,
            disconnect_tx: Some(disconnect_tx),
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
                "addr": session.addr.to_string(),
            })
        }).collect()
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
    #[serde(rename = "type")]
    msg_type: String,
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
pub async fn handle_connection(
    raw_stream: TcpStream,
    addr: SocketAddr,
    state: Arc<Mutex<AppState>>,
    handshake_timeout_secs: u64,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("New WebSocket connection attempt from: {}", addr);

    // 1. WebSocket 握手
    let ws_stream = accept_async(raw_stream).await?;
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

            // 创建 disconnect 通道并注册用户（以 userId:sessionId 为 key）
            let (disconnect_tx, mut disconnect_rx) = oneshot::channel::<()>();
            {
                let mut st = state.lock().await;
                st.add_user(&conn_key, &username, addr, disconnect_tx);
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
                    // 接收客户端消息
                    msg = ws_receiver.next() => {
                        match msg {
                            Some(Ok(msg)) => {
                                match msg {
                                    Message::Text(text) => {
                                        println!("Message from {}:{} ({}){}: {}", user_id, session_id, username, role_str, text);

                                        // 尝试解析为 JSON 管理命令
                                        if let Ok(cmd) = serde_json::from_str::<AdminCommand>(&text) {
                                            if cmd.msg_type == "admin" {
                                                if !is_admin {
                                                    let resp = AdminResponse {
                                                        msg_type: "admin_response".to_string(),
                                                        action: cmd.action,
                                                        status: "error".to_string(),
                                                        message: Some("Permission denied: not an admin".to_string()),
                                                        users: None,
                                                        system_info: None,
                                                    };
                                                    ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                    continue;
                                                }

                                                match cmd.action.as_str() {
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
                                                        let target_id = cmd.user_id.clone().unwrap_or_default();
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
                                                        let target_user = cmd.user_id.clone().unwrap_or_default();
                                                        let target_session = cmd.session_id.clone().unwrap_or_default();
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
                                                        let action_name = cmd.action.clone();
                                                        let resp = AdminResponse {
                                                            msg_type: "admin_response".to_string(),
                                                            action: cmd.action,
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

                                        // 非管理命令：回显
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
