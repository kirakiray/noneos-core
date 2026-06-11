use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tokio::net::TcpStream;
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};
use serde::Serialize;
use crate::crypto::verify_signature;

#[derive(Serialize)]
struct HandshakeResponse {
    #[serde(rename = "type")]
    msg_type: String,
    status: String,
    message: String,
}

pub async fn handle_connection(
    raw_stream: TcpStream,
    addr: SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("新的 WebSocket 连接尝试: {}", addr);

    let ws_stream = accept_async(raw_stream).await?;
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // 握手阶段：等待用户信息
    let handshake_data = match ws_receiver.next().await {
        Some(Ok(Message::Text(text))) => text,
        Some(Ok(_)) => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "握手阶段期望文本消息".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("握手失败: 意外的消息类型".into());
        }
        _ => return Err("握手失败: 连接已关闭".into()),
    };

    let user_info: serde_json::Value = match serde_json::from_str(&handshake_data) {
        Ok(v) => v,
        Err(e) => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: format!("无效的 JSON: {}", e),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err(format!("握手失败: 无效的 JSON: {}", e).into());
        }
    };

    let signature = match user_info.get("signature").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "缺少 'signature' 字段".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("握手失败: 缺少签名".into());
        }
    };

    let public_key = match user_info.get("publicKey").and_then(|v| v.as_str()) {
        Some(s) => s,
        None => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "缺少 'publicKey' 字段".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("握手失败: 缺少公钥".into());
        }
    };

    // 重构被签名的数据
    let mut data_obj = user_info.as_object().ok_or("无效的用户信息格式")?.clone();
    data_obj.remove("signature");
    let signed_message = serde_json::to_string(&data_obj)?;

    println!("验证消息: {}", signed_message);

    // 验证签名
    match verify_signature(public_key, &signed_message, signature) {
        Ok(_) => {
            println!("用户 {} 验证通过", addr);
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "success".to_string(),
                message: "身份验证成功".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
        }
        Err(e) => {
            eprintln!("用户 {} 验证失败: {}", addr, e);
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: format!("验证失败: {}", e),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err(format!("握手失败: {}", e).into());
        }
    }

    // 握手成功后的正常消息处理
    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(msg) => {
                match msg {
                    Message::Text(text) => {
                        println!("收到来自 {} 的消息: {}", addr, text);
                        let response = format!("服务器收到: {}", text);
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
                        println!("客户端 {} 关闭连接", addr);
                        break;
                    }
                    Message::Frame(_) => {}
                }
            }
            Err(e) => {
                eprintln!("WebSocket 错误 ({}): {}", addr, e);
                break;
            }
        }
    }

    Ok(())
}
