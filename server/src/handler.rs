use futures_util::{SinkExt, StreamExt};
use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::net::TcpStream;
use tokio::sync::{oneshot, Mutex};
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};
use serde::{Deserialize, Serialize};
use crate::crypto::verify_signature;
use rand::{thread_rng, Rng};
use rand::distributions::Alphanumeric;

/// 已连接用户的信息
struct UserSession {
    username: String,
    addr: SocketAddr,
    disconnect_tx: Option<oneshot::Sender<()>>,
}

/// 应用共享状态，存储所有已连接用户和管理员配置
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

    fn add_user(&mut self, user_id: &str, username: &str, addr: SocketAddr, disconnect_tx: oneshot::Sender<()>) {
        self.users.insert(user_id.to_string(), UserSession {
            username: username.to_string(),
            addr,
            disconnect_tx: Some(disconnect_tx),
        });
    }

    fn remove_user(&mut self, user_id: &str) -> Option<UserSession> {
        self.users.remove(user_id)
    }

    fn get_all_users(&self) -> Vec<serde_json::Value> {
        self.users.iter().map(|(id, session)| {
            serde_json::json!({
                "userId": id,
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
}

/// 核心业务函数：处理单个 WebSocket 连接的完整生命周期
pub async fn handle_connection(
    raw_stream: TcpStream,
    addr: SocketAddr,
    state: Arc<Mutex<AppState>>,
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

    // 3. 接收响应
    let handshake_data = match ws_receiver.next().await {
        Some(Ok(Message::Text(text))) => text,
        Some(Ok(_)) => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Expected text message during handshake".to_string(),
                is_admin: None,
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("Handshake failed: Unexpected message type".into());
        }
        _ => return Err("Handshake failed: Connection closed by client".into()),
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

    // 提取 userId 和 username
    let user_id = handshake_obj.get("userId")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let username = handshake_obj.get("username")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();

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

            // 创建 disconnect 通道并注册用户
            let (disconnect_tx, mut disconnect_rx) = oneshot::channel::<()>();
            {
                let mut st = state.lock().await;
                st.add_user(&user_id, &username, addr, disconnect_tx);
            }

            let role_str = if is_admin { " (ADMIN)" } else { "" };
            println!("Handshake: User {} ({}) authenticated successfully{}", user_id, username, role_str);

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
                        println!("User {} ({}) disconnected by admin", user_id, username);
                        let _ = ws_sender.send(Message::Close(None)).await;
                        break;
                    }
                    // 接收客户端消息
                    msg = ws_receiver.next() => {
                        match msg {
                            Some(Ok(msg)) => {
                                match msg {
                                    Message::Text(text) => {
                                        println!("Message from {} ({}){}: {}", user_id, username, role_str, text);

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
                                                            };
                                                            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                        } else {
                                                            let result = {
                                                                let mut st = state.lock().await;
                                                                if let Some(mut session) = st.remove_user(&target_id) {
                                                                    if let Some(tx) = session.disconnect_tx.take() {
                                                                        let _ = tx.send(());
                                                                    }
                                                                    true
                                                                } else {
                                                                    false
                                                                }
                                                            };
                                                            if result {
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "disconnect_user".to_string(),
                                                                    status: "ok".to_string(),
                                                                    message: Some(format!("User {} disconnected", target_id)),
                                                                    users: None,
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                                println!("Admin {} disconnected user {}", user_id, target_id);
                                                            } else {
                                                                let resp = AdminResponse {
                                                                    msg_type: "admin_response".to_string(),
                                                                    action: "disconnect_user".to_string(),
                                                                    status: "error".to_string(),
                                                                    message: Some(format!("User {} not found", target_id)),
                                                                    users: None,
                                                                };
                                                                ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
                                                            }
                                                        }
                                                    }
                                                    _ => {
                                                        let action_name = cmd.action.clone();
                                                        let resp = AdminResponse {
                                                            msg_type: "admin_response".to_string(),
                                                            action: cmd.action,
                                                            status: "error".to_string(),
                                                            message: Some(format!("Unknown admin action: {}", action_name)),
                                                            users: None,
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
                                        println!("Connection closed by client: {} ({})", user_id, addr);
                                        break;
                                    }
                                    Message::Frame(_) => {}
                                }
                            }
                            Some(Err(e)) => {
                                eprintln!("WebSocket error for {} ({}): {}", user_id, addr, e);
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
                st.remove_user(&user_id);
            }
            println!("User {} ({}) removed from state", user_id, username);
        }
        Err(e) => {
            eprintln!("Handshake: User {} authentication FAILED: {}", user_id, e);
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
