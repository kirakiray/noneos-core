/// 连接处理: WebSocket 握手、消息路由、中继转发
/// 核心改进:
/// - traffic 使用 tokio::sync::RwLock（不阻塞 async runtime）
/// - DB 操作通过 actor channel 异步投递
/// - 所有 lock 都是 .await 而非 .unwrap()
/// - 错误处理更健壮，不会 panic 污染状态

use std::net::SocketAddr;
use std::sync::Arc;
use futures_util::{SinkExt, StreamExt};
use tokio::net::TcpStream;
use tokio::sync::{oneshot, mpsc};
use tokio::time::{timeout, Duration};
use tokio_tungstenite::{
    accept_hdr_async,
    tungstenite::{
        protocol::Message,
        handshake::server::{Request, Response, ErrorResponse},
    },
};
use rand::{thread_rng, Rng};
use rand::distributions::Alphanumeric;

use crate::config::Config;
use crate::crypto::verify_signature;
use crate::protocol::{self, HandshakeChallenge, HandshakeResponse, BinaryRelayHeader};
use crate::state::AppState;
use crate::admin;
use crate::db;

/// 处理单个 WebSocket 连接（由 main.rs 中 tokio::spawn 调用）
pub async fn handle_connection(
    raw_stream: TcpStream,
    addr: SocketAddr,
    state: Arc<AppState>,
) {
    eprintln!("[conn] New connection from {}", addr);

    // 1. WebSocket 升级，捕获 Origin
    let client_origin = std::sync::Mutex::new(String::new());
    let ws_stream = match accept_hdr_async(raw_stream, |req: &Request, response: Response| {
        if let Some(origin_val) = req.headers().get("origin") {
            if let Ok(origin_str) = origin_val.to_str() {
                if let Ok(mut origin) = client_origin.lock() {
                    *origin = origin_str.to_string();
                }
            }
        }
        Ok::<_, ErrorResponse>(response)
    }).await {
        Ok(ws) => ws,
        Err(e) => {
            eprintln!("[conn] WebSocket upgrade failed from {}: {}", addr, e);
            return;
        }
    };
    let client_origin = client_origin.into_inner().unwrap_or_default();
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();
    let cfg = &state.config;

    // 2. 生成并发送挑战
    let challenge: String = thread_rng()
        .sample_iter(&Alphanumeric)
        .take(32)
        .map(char::from)
        .collect();

    let challenge_msg = HandshakeChallenge {
        msg_type: "handshake_challenge".to_string(),
        challenge: challenge.clone(),
    };
    if ws_sender.send(Message::Text(
        serde_json::to_string(&challenge_msg).unwrap_or_default()
    )).await.is_err() {
        return;
    }

    // 3. 接收握手响应（带超时）
    let handshake_text: String = match timeout(
        Duration::from_secs(cfg.handshake_timeout_secs),
        ws_receiver.next(),
    ).await {
        Ok(Some(Ok(Message::Text(text)))) => {
            if text.len() > cfg.handshake_max_size {
                send_handshake_error(&mut ws_sender, "handshake", &format!(
                    "Handshake data too large: {} bytes (max {} bytes)",
                    text.len(), cfg.handshake_max_size
                )).await;
                return;
            }
            text
        }
        Ok(Some(Ok(_))) => {
            send_handshake_error(&mut ws_sender, "handshake", "Expected text message during handshake").await;
            return;
        }
        Ok(Some(Err(e))) => {
            eprintln!("[conn] WebSocket error during handshake from {}: {}", addr, e);
            return;
        }
        Ok(None) => {
            eprintln!("[conn] Client {} closed connection during handshake", addr);
            return;
        }
        Err(_) => {
            send_handshake_error(&mut ws_sender, "handshake", &format!(
                "Handshake timeout: no response within {} seconds",
                cfg.handshake_timeout_secs
            )).await;
            return;
        }
    };

    let handshake_size = handshake_text.len();

    // 4. 解析握手 JSON
    let mut handshake_obj: serde_json::Map<String, serde_json::Value> = match serde_json::from_str(&handshake_text) {
        Ok(serde_json::Value::Object(v)) => v,
        _ => {
            send_handshake_error(&mut ws_sender, "handshake", "Invalid JSON format or not an object").await;
            return;
        }
    };

    // 5. 验证挑战
    let _received_challenge = match handshake_obj.get("challenge").and_then(|v| v.as_str()) {
        Some(s) if s == challenge.as_str() => s,
        Some(_) => {
            send_handshake_error(&mut ws_sender, "handshake", "Challenge mismatch").await;
            return;
        }
        None => {
            send_handshake_error(&mut ws_sender, "handshake", "Missing 'challenge' field").await;
            return;
        }
    };

    // 6. 提取字段
    let signature = match handshake_obj.get("signature").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => { send_handshake_error(&mut ws_sender, "handshake", "Missing 'signature'").await; return; }
    };
    let public_key = match handshake_obj.get("publicKey").and_then(|v| v.as_str()) {
        Some(s) => s.to_string(),
        None => { send_handshake_error(&mut ws_sender, "handshake", "Missing 'publicKey'").await; return; }
    };
    let user_id = handshake_obj.get("userId").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
    let session_id = handshake_obj.get("sessionId").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
    let username = handshake_obj.get("username").and_then(|v| v.as_str()).unwrap_or("unknown").to_string();
    let conn_key = format!("{}:{}", user_id, session_id);

    // 7. 签名验证
    handshake_obj.remove("signature");
    let signed_message = match serde_json::to_string(&handshake_obj) {
        Ok(s) => s,
        Err(e) => {
            send_handshake_error(&mut ws_sender, "handshake", &format!("Serialization error: {}", e)).await;
            return;
        }
    };

    match verify_signature(&public_key, &signed_message, &signature) {
        Ok(()) => {}
        Err(e) => {
            send_handshake_error(&mut ws_sender, "handshake", &format!("Verification failed: {}", e)).await;
            return;
        }
    }

    // 8. 权限检查
    let is_admin = state.is_admin(&user_id);

    // 内存过载保护
    if !is_admin {
        let mem_usage = admin::get_memory_usage_percent().await;
        if mem_usage > cfg.max_memory_usage_percent {
            send_handshake_error(&mut ws_sender, "handshake", &format!(
                "Server memory usage too high ({:.1}% > {:.0}%), connection rejected",
                mem_usage, cfg.max_memory_usage_percent
            )).await;
            return;
        }
    }

    // 9. 注册用户
    let (disconnect_tx, mut disconnect_rx) = oneshot::channel::<()>();
    let (data_tx, mut data_rx) = mpsc::unbounded_channel::<Message>();
    let data_tx_for_watcher = data_tx.clone();

    if let Err(e) = state.add_user(&conn_key, &username, &client_origin, addr, disconnect_tx, data_tx) {
        send_handshake_error(&mut ws_sender, "handshake", &e).await;
        return;
    }

    // 10. 注册流量统计
    {
        let mut tr = state.traffic.write().await;
        let now = protocol::now_ms();
        tr.register_session(&conn_key, &user_id, &session_id, &username, now);
        tr.add_handshake(&conn_key, handshake_size as u64, now);
    }

    // 11. 持久化用户信息
    if let Some(ref db_tx) = state.db {
        let _ = db_tx.send(db::DbCmd::SaveUser {
            user_id: user_id.clone(),
            username: username.clone(),
            public_key: public_key.clone(),
            first_seen_at: protocol::now_ms(),
            last_seen_at: protocol::now_ms(),
        });
    }

    // 12. 发送握手成功
    let role_str = if is_admin { " (ADMIN)" } else { "" };
    eprintln!("[auth] {}:{} ({}) authenticated{} from {}", user_id, session_id, username, role_str, addr);

    let resp = HandshakeResponse {
        msg_type: "handshake".to_string(),
        status: "success".to_string(),
        message: "Authentication successful".to_string(),
        is_admin: Some(is_admin),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
    };
    if ws_sender.send(Message::Text(serde_json::to_string(&resp).unwrap_or_default())).await.is_err() {
        cleanup_session(&state, &conn_key, &user_id, &session_id, &username).await;
        return;
    }

    // 13. 消息主循环（传入 data_tx_for_watcher 供 watcher 系统使用）
    run_message_loop(
        &mut ws_sender,
        &mut ws_receiver,
        &mut disconnect_rx,
        &mut data_rx,
        data_tx_for_watcher,
        &state,
        &conn_key,
        &user_id,
        &session_id,
        &username,
        is_admin,
    ).await;

    // 14. 清理
    cleanup_session(&state, &conn_key, &user_id, &session_id, &username).await;
}

async fn run_message_loop(
    ws_sender: &mut (impl SinkExt<Message> + Unpin),
    ws_receiver: &mut (impl StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin),
    disconnect_rx: &mut oneshot::Receiver<()>,
    data_rx: &mut mpsc::UnboundedReceiver<Message>,
    data_tx_for_watcher: mpsc::UnboundedSender<Message>,
    state: &Arc<AppState>,
    conn_key: &str,
    user_id: &str,
    session_id: &str,
    username: &str,
    is_admin: bool,
) {
    let role_str = if is_admin { " (ADMIN)" } else { "" };

    loop {
        tokio::select! {
            // 管理员断开信号
            _ = &mut *disconnect_rx => {
                eprintln!("[disc] {}:{} ({}) disconnected by admin", user_id, session_id, username);
                let _ = ws_sender.send(Message::Close(None)).await;
                break;
            }

            // 转发数据到达
            Some(forward_msg) = data_rx.recv() => {
                let out_size = protocol::msg_byte_size(&forward_msg) as u64;
                if out_size > 0 {
                    state.traffic.write().await.add_outbound(conn_key, out_size, protocol::now_ms());
                }
                if ws_sender.send(forward_msg).await.is_err() {
                    break;
                }
            }

            // 客户端消息到达
            msg = ws_receiver.next() => {
                match msg {
                    Some(Ok(msg)) => {
                        if !handle_client_message(ws_sender, msg, state, conn_key, user_id, session_id, username, role_str, is_admin, &data_tx_for_watcher).await {
                            break;
                        }
                    }
                    Some(Err(e)) => {
                        eprintln!("[ws] WebSocket error from {}:{} - {}", user_id, session_id, e);
                        break;
                    }
                    None => {
                        eprintln!("[ws] {}:{} ({}) connection closed", user_id, session_id, username);
                        break;
                    }
                }
            }
        }
    }
}

/// 处理单条客户端消息，返回 false 表示需要断开连接
async fn handle_client_message(
    ws_sender: &mut (impl SinkExt<Message> + Unpin),
    msg: Message,
    state: &Arc<AppState>,
    conn_key: &str,
    user_id: &str,
    session_id: &str,
    username: &str,
    role_str: &str,
    is_admin: bool,
    data_tx_for_watcher: &mpsc::UnboundedSender<Message>,
) -> bool {
    match msg {
        Message::Text(text) => {
            let cfg = &state.config;

            // 大小检查
            if text.len() > cfg.text_message_max_size {
                eprintln!("[msg] Oversized text from {}:{} ({} bytes)", user_id, session_id, text.len());
                let resp = serde_json::json!({
                    "type": "error", "status": "error",
                    "message": format!("Text message too large: {} bytes (max {} bytes)", text.len(), cfg.text_message_max_size)
                });
                let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                return true;
            }

            // 流量统计（快速路径，大部分消息的处理）
            {
                state.traffic.write().await.add_inbound(conn_key, text.len() as u64, protocol::now_ms());
            }

            // 日志（截断长消息）
            if text.len() <= 500 {
                eprintln!("[msg] {}:{} {}: {}", user_id, session_id, role_str, text);
            } else {
                eprintln!("[msg] {}:{} {}: {}... ({} bytes)", user_id, session_id, role_str, &text[..500], text.len());
            }

            // 解析 JSON
            let cmd: serde_json::Value = match serde_json::from_str(&text) {
                Ok(v) => v,
                Err(_) => return true, // 非 JSON，忽略
            };

            let msg_type = cmd.get("type").and_then(|v| v.as_str()).unwrap_or("");

            match msg_type {
                // 管理命令
                "admin" => {
                    if !is_admin {
                        let resp = serde_json::json!({
                            "type": "admin_response",
                            "action": "",
                            "status": "error",
                            "message": "Permission denied: not an admin"
                        });
                        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                        return true;
                    }
                    if let Ok(admin_cmd) = serde_json::from_str(&text) {
                        let resp = admin::handle_admin_command(state, admin_cmd, user_id, session_id).await;
                        let _ = ws_sender.send(Message::Text(serde_json::to_string(&resp).unwrap_or_default())).await;
                    }
                }

                // 查询用户在线状态
                "query" => {
                    let action = cmd.get("action").and_then(|v| v.as_str()).unwrap_or("");
                    if action == "user_online" {
                        let target = cmd.get("user_id").and_then(|v| v.as_str()).unwrap_or("");
                        if target.is_empty() {
                            let resp = serde_json::json!({
                                "type": "query_response", "action": "user_online",
                                "status": "error", "message": "Missing user_id"
                            });
                            let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                        } else {
                            let session_info = state.get_user_sessions_with_latency(target);
                            let online = !session_info.is_empty();
                            let sessions: Vec<String> = session_info.iter()
                                .filter_map(|s| s["sessionId"].as_str().map(String::from))
                                .collect();
                            let resp = serde_json::json!({
                                "type": "query_response", "action": "user_online",
                                "status": "ok", "online": online,
                                "sessions": sessions, "sessionInfo": session_info
                            });
                            let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                        }
                    } else {
                        let resp = serde_json::json!({
                            "type": "query_response", "action": action,
                            "status": "error", "message": format!("Unknown query action: {}", action)
                        });
                        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                    }
                }

                // 关注用户
                "watch_user" => {
                    let target = cmd.get("target_user_id").and_then(|v| v.as_str()).unwrap_or("");
                    if target.is_empty() {
                        let resp = serde_json::json!({
                            "type": "watch_user_response", "status": "error", "message": "Missing target_user_id"
                        });
                        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                    } else {
                        state.add_watcher(conn_key, target, data_tx_for_watcher.clone());
                        let resp = serde_json::json!({
                            "type": "watch_user_response", "status": "ok",
                            "message": format!("Now watching user {}", target)
                        });
                        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                        eprintln!("[watch] {}:{} -> {}", user_id, session_id, target);
                    }
                }

                // 取消关注
                "unwatch_user" => {
                    let target = cmd.get("target_user_id").and_then(|v| v.as_str()).unwrap_or("");
                    if target.is_empty() {
                        let resp = serde_json::json!({
                            "type": "unwatch_user_response", "status": "error", "message": "Missing target_user_id"
                        });
                        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                    } else {
                        state.remove_watcher(conn_key, target);
                        let resp = serde_json::json!({
                            "type": "unwatch_user_response", "status": "ok",
                            "message": format!("Stopped watching user {}", target)
                        });
                        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                    }
                }

                // 更新服务列表
                "update_services" => {
                    let services: Vec<String> = cmd.get("services")
                        .and_then(|v| v.as_array())
                        .map(|arr| arr.iter().filter_map(|s| s.as_str().map(String::from)).collect())
                        .unwrap_or_default();
                    state.update_services(user_id, session_id, services);
                }

                // 🔁 relay 文本转发
                "relay" => {
                    let action = cmd.get("action").and_then(|v| v.as_str()).unwrap_or("");
                    if action == "send_data" {
                        handle_text_relay(ws_sender, state, &cmd, conn_key, user_id, session_id).await;
                    } else {
                        let resp = serde_json::json!({
                            "type": "relay_response", "action": action,
                            "status": "error", "message": format!("Unknown relay action: {}", action)
                        });
                        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                    }
                }

                // 延迟测量
                "latency_test" => {
                    let client_time = cmd.get("client_time").and_then(|v| v.as_u64()).unwrap_or(0);
                    let now = protocol::now_ms();
                    let resp = serde_json::json!({
                        "type": "latency_test_response",
                        "client_time": client_time,
                        "server_recv_time": now,
                        "server_send_time": now
                    });
                    let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                }

                "latency_report" => {
                    let client_time = cmd.get("client_time").and_then(|v| v.as_u64()).unwrap_or(0);
                    let client_recv_time = cmd.get("client_recv_time").and_then(|v| v.as_u64()).unwrap_or(0);
                    if client_time > 0 && client_recv_time > client_time {
                        let rtt = client_recv_time - client_time;
                        let one_way = rtt / 2;
                        eprintln!("[rtt] {}:{} RTT: {}ms, one-way: ~{}ms", user_id, session_id, rtt, one_way);
                        state.update_latency(user_id, session_id, rtt);
                    }
                    let ack = serde_json::json!({
                        "type": "latency_report_ack",
                        "server_recv_time": protocol::now_ms(),
                        "status": "ok"
                    });
                    let _ = ws_sender.send(Message::Text(ack.to_string())).await;
                }

                _ => {} // 未知类型，忽略
            }
        }

        Message::Binary(data) => {
            let cfg = &state.config;

            // 入站统计
            {
                state.traffic.write().await.add_inbound(conn_key, data.len() as u64, protocol::now_ms());
            }

            let binary_max_size = cfg.binary_payload_max_size + 4096;
            if data.len() > binary_max_size {
                let resp = serde_json::json!({
                    "type": "relay_response", "action": "send_data", "status": "error",
                    "message": format!("Binary too large: {} bytes (max {})", data.len(), binary_max_size)
                });
                let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                return true;
            }

            // 解析二进制 relay 帧
            if data.len() < 4 {
                let resp = serde_json::json!({
                    "type": "relay_response", "action": "send_data", "status": "error",
                    "message": "Invalid binary relay frame: too short"
                });
                let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                return true;
            }

            let header_len = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
            if header_len > data.len() - 4 {
                let resp = serde_json::json!({
                    "type": "relay_response", "action": "send_data", "status": "error",
                    "message": "Invalid binary relay frame: header length out of bounds"
                });
                let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                return true;
            }

            let header: BinaryRelayHeader = match serde_json::from_slice(&data[4..4 + header_len]) {
                Ok(v) => v,
                Err(_) => {
                    let resp = serde_json::json!({
                        "type": "relay_response", "action": "send_data", "status": "error",
                        "message": "Invalid binary relay frame: header JSON parse failed"
                    });
                    let _ = ws_sender.send(Message::Text(resp.to_string())).await;
                    return true;
                }
            };

            let header_type = header.msg_type.as_deref().unwrap_or("");
            let header_action = header.action.as_deref().unwrap_or("");

            if header_type == "relay" && header_action == "send_data" {
                handle_binary_relay(ws_sender, state, &header, &data, header_len, conn_key, user_id, session_id, cfg).await;
            }
        }

        Message::Ping(data) => {
            let _ = ws_sender.send(Message::Pong(data)).await;
        }
        Message::Pong(_) => {}
        Message::Close(_) => {
            eprintln!("[ws] {}:{} ({}) closed by client", user_id, session_id, username);
            return false;
        }
        Message::Frame(_) => {}
    }

    true
}

// ── 文本 relay 处理 ──

async fn handle_text_relay(
    ws_sender: &mut (impl SinkExt<Message> + Unpin),
    state: &Arc<AppState>,
    cmd: &serde_json::Value,
    conn_key: &str,
    user_id: &str,
    session_id: &str,
) {
    let target_user = cmd.get("target_user_id").and_then(|v| v.as_str()).unwrap_or("");
    let target_session = cmd.get("target_session_id").and_then(|v| v.as_str()).unwrap_or("");
    let relay_data = cmd.get("data");

    if target_user.is_empty() || target_session.is_empty() || relay_data.is_none() {
        let resp = serde_json::json!({
            "type": "relay_response", "action": "send_data", "status": "error",
            "message": "Missing target_user_id, target_session_id, or data"
        });
        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
        return;
    }

    let forward_msg = serde_json::json!({
        "type": "relay",
        "from_user_id": user_id,
        "from_session_id": session_id,
        "data": relay_data
    });
    let forward_text = match serde_json::to_string(&forward_msg) {
        Ok(s) => s,
        Err(_) => return,
    };
    let forward_len = forward_text.len() as u64;

    // 检查额度
    if !state.check_relay_quota(user_id, forward_len) {
        let quota = state.get_or_create_user_quota(user_id);
        let resp = serde_json::json!({
            "type": "relay_response", "action": "send_data", "status": "quota_exceeded",
            "message": format!("Relay quota exceeded: used {} / {} bytes, only <= {} bytes allowed",
                quota.used_bytes, quota.quota_bytes, state.config.relay_small_message_max_bytes)
        });
        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
        return;
    }

    let delivered = if let Some(tx) = state.get_session_data_tx(target_user, target_session) {
        tx.send(Message::Text(forward_text)).is_ok()
    } else {
        false
    };

    if delivered {
        {
            state.traffic.write().await.add_relay_forwarded(conn_key, forward_len, protocol::now_ms());
        }
        state.record_relay_usage(user_id, forward_len);
        let resp = serde_json::json!({
            "type": "relay_response", "action": "send_data", "status": "ok",
            "message": "Data delivered to target"
        });
        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
        state.reset_relay_failure(conn_key);
    } else {
        let resp = serde_json::json!({
            "type": "relay_response", "action": "send_data", "status": "error",
            "message": "Target session not found or offline"
        });
        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
        let should_kick = state.handle_relay_failure(user_id, session_id);
        if should_kick {
            eprintln!("[relay] {}:{} kicked for relay abuse", user_id, session_id);
            let _ = ws_sender.send(Message::Close(None)).await;
        }
    }
}

// ── 二进制 relay 处理 ──

async fn handle_binary_relay(
    ws_sender: &mut (impl SinkExt<Message> + Unpin),
    state: &Arc<AppState>,
    header: &BinaryRelayHeader,
    data: &[u8],
    header_len: usize,
    conn_key: &str,
    user_id: &str,
    session_id: &str,
    cfg: &Config,
) {
    let target_user = header.target_user_id.as_deref().unwrap_or("");
    let target_session = header.target_session_id.as_deref().unwrap_or("");

    if target_user.is_empty() || target_session.is_empty() {
        let resp = serde_json::json!({
            "type": "relay_response", "action": "send_data", "status": "error",
            "message": "Missing target_user_id or target_session_id"
        });
        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
        return;
    }

    let payload = &data[4 + header_len..];
    if payload.len() > cfg.binary_payload_max_size {
        let resp = serde_json::json!({
            "type": "relay_response", "action": "send_data", "status": "error",
            "message": format!("Relay payload too large: {} bytes (max {})", payload.len(), cfg.binary_payload_max_size)
        });
        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
        return;
    }

    let forward_header = serde_json::json!({
        "type": "relay",
        "from_user_id": user_id,
        "from_session_id": session_id,
    });
    let forward_header_bytes = match serde_json::to_vec(&forward_header) {
        Ok(b) => b,
        Err(_) => return,
    };
    let forward_header_len = forward_header_bytes.len() as u32;

    let mut forward_frame = Vec::with_capacity(4 + forward_header_bytes.len() + payload.len());
    forward_frame.extend_from_slice(&forward_header_len.to_be_bytes());
    forward_frame.extend_from_slice(&forward_header_bytes);
    forward_frame.extend_from_slice(payload);
    let forward_size = forward_frame.len() as u64;

    if !state.check_relay_quota(user_id, forward_size) {
        let quota = state.get_or_create_user_quota(user_id);
        let resp = serde_json::json!({
            "type": "relay_response", "action": "send_data", "status": "quota_exceeded",
            "message": format!("Relay quota exceeded: used {} / {} bytes, only <= {} bytes allowed",
                quota.used_bytes, quota.quota_bytes, cfg.relay_small_message_max_bytes)
        });
        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
        return;
    }

    let delivered = if let Some(tx) = state.get_session_data_tx(target_user, target_session) {
        tx.send(Message::Binary(forward_frame)).is_ok()
    } else {
        false
    };

    if delivered {
        {
            state.traffic.write().await.add_relay_forwarded(conn_key, forward_size, protocol::now_ms());
        }
        state.record_relay_usage(user_id, forward_size);
        let resp = serde_json::json!({
            "type": "relay_response", "action": "send_data", "status": "ok",
            "message": "Binary data delivered to target"
        });
        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
        state.reset_relay_failure(conn_key);
    } else {
        let resp = serde_json::json!({
            "type": "relay_response", "action": "send_data", "status": "error",
            "message": "Target session not found or offline"
        });
        let _ = ws_sender.send(Message::Text(resp.to_string())).await;
        let should_kick = state.handle_relay_failure(user_id, session_id);
        if should_kick {
            eprintln!("[relay] {}:{} kicked for relay abuse", user_id, session_id);
            let _ = ws_sender.send(Message::Close(None)).await;
        }
    }
}

// ── 辅助函数 ──

async fn send_handshake_error(
    ws_sender: &mut (impl SinkExt<Message> + Unpin),
    msg_type: &str,
    message: &str,
) {
    let resp = HandshakeResponse {
        msg_type: msg_type.to_string(),
        status: "error".to_string(),
        message: message.to_string(),
        is_admin: None,
        version: None,
    };
    let _ = ws_sender.send(Message::Text(serde_json::to_string(&resp).unwrap_or_default())).await;
    let _ = ws_sender.send(Message::Close(None)).await;
}

async fn cleanup_session(
    state: &Arc<AppState>,
    conn_key: &str,
    user_id: &str,
    session_id: &str,
    username: &str,
) {
    state.remove_all_watchers(conn_key);
    state.remove_user(conn_key);
    state.notify_watchers_session_left(user_id, session_id, username);

    // 最终流量落盘
    let session_stats = {
        let mut tr = state.traffic.write().await;
        tr.remove_session(conn_key)
    };

    if let Some(ref db_tx) = state.db {
        if let Some(s) = session_stats {
            let _ = db_tx.send(db::DbCmd::SaveSessionFinal {
                snapshot: db::SessionSnapshot {
                    user_id: s.user_id,
                    session_id: s.session_id,
                    username: s.username,
                    inbound_bytes: s.inbound_bytes,
                    outbound_bytes: s.outbound_bytes,
                    relay_forwarded_bytes: s.relay_forwarded_bytes,
                    handshake_bytes: s.handshake_bytes,
                },
            });
        }
        if let Some(quota) = state.user_quotas.get(user_id) {
            let _ = db_tx.send(db::DbCmd::SaveUserRelayQuota {
                user_id: quota.user_id.clone(),
                quota_bytes: quota.quota_bytes,
                used_bytes: quota.used_bytes,
                updated_at: quota.updated_at,
            });
        }
    }

    eprintln!("[clean] {}:{} ({}) removed", user_id, session_id, username);
}
