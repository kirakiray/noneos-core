use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tokio::net::TcpStream;
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};
use serde::Serialize;
use crate::crypto::verify_signature;

/// 握手阶段返回给客户端的响应格式
/// 客户端根据 type="handshake" 和 status 来判断连接是否被服务器认可
#[derive(Serialize)]
struct HandshakeResponse {
    /// 消息类型标识，方便客户端在 onmessage 中分发处理
    #[serde(rename = "type")]
    msg_type: String,
    /// 处理状态标识："success" 表示验证通过，"error" 表示拒绝连接
    status: String,
    /// 给用户的提示信息，如果是错误状态则包含错误原因
    message: String,
}

/// 核心业务函数：处理单个 WebSocket 连接的完整生命周期
/// 包括：WebSocket 协议升级 -> 身份验证握手 -> 正常通信循环
pub async fn handle_connection(
    raw_stream: TcpStream,
    addr: SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("New WebSocket connection attempt from: {}", addr);

    // 1. WebSocket 握手：将底层的 TCP 流升级为 WebSocket 协议流
    let ws_stream = accept_async(raw_stream).await?;
    // 将流拆分为发送端（sink）和接收端（stream），方便并发或顺序处理
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // 2. 身份验证阶段：服务器强制要求客户端发送的第一条消息必须是已签名的用户信息
    let handshake_data = match ws_receiver.next().await {
        Some(Ok(Message::Text(text))) => text,
        Some(Ok(_)) => {
            // 如果收到的不是文本消息（如二进制），直接拒绝并关闭
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: "Expected text message during handshake".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err("Handshake failed: Unexpected message type".into());
        }
        _ => return Err("Handshake failed: Connection closed by client".into()),
    };

    // 3. 数据解析：尝试将收到的文本解析为 JSON 对象
    let user_info: serde_json::Value = match serde_json::from_str(&handshake_data) {
        Ok(v) => v,
        Err(e) => {
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: format!("Invalid JSON format: {}", e),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err(format!("Handshake failed: Invalid JSON: {}", e).into());
        }
    };

    // 4. 字段校验：检查是否包含签名和公钥
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

    // 5. 签名比对：重构被签名的数据字符串
    // 重要：JS 端签名时移除了 signature 字段并对键进行了排序
    // 这里我们从解析后的 JSON 中移除 signature，serde_json 的 Object 默认也是按键排序的
    let mut data_obj = user_info.as_object().ok_or("Invalid user info object")?.clone();
    data_obj.remove("signature");
    let signed_message = serde_json::to_string(&data_obj)?;

    println!("Handshake: Verifying signature for user at {}", addr);

    // 6. 调用加密模块验证签名
    match verify_signature(public_key, &signed_message, signature) {
        Ok(_) => {
            // 验证成功：通知客户端可以开始正常通信
            println!("Handshake: User {} authenticated successfully", addr);
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "success".to_string(),
                message: "Authentication successful".to_string(),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
        }
        Err(e) => {
            // 验证失败：记录错误日志并通知客户端，随后退出处理函数以断开连接
            eprintln!("Handshake: User {} authentication FAILED: {}", addr, e);
            let resp = HandshakeResponse {
                msg_type: "handshake".to_string(),
                status: "error".to_string(),
                message: format!("Verification failed: {}", e),
            };
            ws_sender.send(Message::Text(serde_json::to_string(&resp)?)).await?;
            return Err(format!("Handshake failed: {}", e).into());
        }
    }

    // 7. 通信循环：握手成功后，进入正常的消息收发处理阶段
    // 这里简单实现了一个 Echo 服务器逻辑
    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(msg) => {
                match msg {
                    Message::Text(text) => {
                        println!("Message from {}: {}", addr, text);
                        // 回显文本消息给客户端
                        let response = format!("Server received: {}", text);
                        ws_sender.send(Message::Text(response)).await?;
                    }
                    Message::Binary(data) => {
                        // 原样回发二进制消息
                        ws_sender.send(Message::Binary(data)).await?;
                    }
                    Message::Ping(data) => {
                        // 自动响应 WebSocket Ping
                        ws_sender.send(Message::Pong(data)).await?;
                    }
                    Message::Pong(_) => {}
                    Message::Close(_) => {
                        println!("Connection closed by client: {}", addr);
                        break;
                    }
                    Message::Frame(_) => {}
                }
            }
            Err(e) => {
                eprintln!("WebSocket error for {}: {}", addr, e);
                break;
            }
        }
    }

    Ok(())
}
