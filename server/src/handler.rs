use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tokio::net::TcpStream;
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};
use serde::Serialize;
use crate::crypto::verify_signature;

/// 握手响应结构体
#[derive(Serialize)]
struct HandshakeResponse {
    /// 消息类型，固定为 "handshake"
    #[serde(rename = "type")]
    msg_type: String,
    /// 状态: "success" 或 "error"
    status: String,
    /// 详细提示信息
    message: String,
}

/// 处理新的 WebSocket 连接
pub async fn handle_connection(
    raw_stream: TcpStream,
    addr: SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("New WebSocket connection attempt: {}", addr);

    // 接受 WebSocket 握手
    let ws_stream = accept_async(raw_stream).await?;
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // 握手阶段：等待客户端发送用户信息
    let handshake_data = match ws_receiver.next().await {
        Some(Ok(Message::Text(text))) => text,
        Some(Ok(_)) => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Expected text message during handshake".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("Handshake failed: Unexpected message type".into());
        }
        _ => return Err("Handshake failed: Connection closed".into()),
    };

    // 解析用户信息 JSON
    let user_info: serde_json::Value = match serde_json::from_str(&handshake_data) {
        Ok(v) => v,
        Err(e) => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: format!("Invalid JSON: {}", e),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err(format!("Handshake failed: Invalid JSON: {}", e).into());
        }
    };

    // 获取签名
    let signature = match user_info.get("signature").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Missing 'signature' field".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("Handshake failed: Missing signature".into());
        }
    };

    // 获取公钥
    let public_key = match user_info.get("publicKey").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Missing 'publicKey' field".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("Handshake failed: Missing publicKey".into());
        }
    };

    // 重构被签名的数据（移除 signature 字段）
    let mut data_obj = user_info.as_object().ok_or("Invalid user info format")?.clone();
    data_obj.remove("signature");
    let signed_message = serde_json::to_string(&data_obj)?;

    println!("Verifying message: {}", signed_message);

    // 验证签名
    match verify_signature(public_key, &signed_message, signature) {
        Ok(_) => {
            println!("User {} verified successfully", addr);
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "success".to_string(),
                message: "Authentication successful".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
        }
        Err(e) => {
            eprintln!("User {} verification failed: {}", addr, e);
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: format!("Verification failed: {}", e),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err(format!("Handshake failed: {}", e).into());
        }
    }

    // 握手成功后的正常消息循环
    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(msg) => {
                match msg {
                    Message::Text(text) => {
                        println!("Received from {}: {}", addr, text);
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
                        println!("Client {} disconnected", addr);
                        break;
                    }
                    Message::Frame(_) => {}
                }
            }
            Err(e) => {
                eprintln!("WebSocket error ({}): {}", addr, e);
                break;
            }
        }
    }

    Ok(())
}
