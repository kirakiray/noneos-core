use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};
use serde::{Deserialize, Serialize};
use clap::Parser;
use std::fs;
use std::path::PathBuf;
use p256::ecdsa::{VerifyingKey, Signature, signature::Verifier};
use p256::pkcs8::DecodePublicKey;
use base64::{engine::general_purpose, Engine as _};

#[derive(Parser, Debug)]
#[command(author, version, about, long_about = None)]
struct Args {
    /// 配置文件路径
    #[arg(short, long, value_name = "FILE")]
    config: Option<PathBuf>,
}

#[derive(Debug, Deserialize)]
struct Config {
    #[serde(default = "default_port")]
    port: u16,
    #[serde(default = "default_host")]
    host: String,
}

fn default_port() -> u16 {
    8081
}

fn default_host() -> String {
    "127.0.0.1".to_string()
}

impl Default for Config {
    fn default() -> Self {
        Self {
            port: default_port(),
            host: default_host(),
        }
    }
}

#[derive(Serialize)]
struct HandshakeResponse {
    #[serde(rename = "type")]
    msg_type: String,
    status: String,
    message: String,
}

fn verify_signature(public_key_b64: &str, message: &str, signature_b64: &str) -> Result<(), String> {
    // 1. 解码公钥 (SPKI 格式)
    let public_key_der = general_purpose::STANDARD
        .decode(public_key_b64)
        .map_err(|e| format!("无法解码公钥 base64: {}", e))?;
    
    let verifying_key = VerifyingKey::from_public_key_der(&public_key_der)
        .map_err(|e| format!("无法解析公钥 SPKI: {}", e))?;

    // 2. 解码签名 (Web Crypto 对于 ECDSA 返回原始 R|S 字节)
    let signature_bytes = general_purpose::STANDARD
        .decode(signature_b64)
        .map_err(|e| format!("无法解码签名 base64: {}", e))?;
    
    let signature = Signature::from_slice(&signature_bytes)
        .map_err(|e| format!("无法解析签名: {}", e))?;

    // 3. 验证
    verifying_key.verify(message.as_bytes(), &signature)
        .map_err(|e| format!("签名验证失败: {}", e))?;

    Ok(())
}

async fn handle_connection(
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
    // 在 JS 端，我们已经确保了键是按字母顺序排序的
    // serde_json::Value::as_object().unwrap() 返回的 Map 默认也是按字母顺序排序的
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

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args = Args::parse();

    let config = if let Some(config_path) = args.config {
        println!("正在从 {:?} 加载配置...", config_path);
        let config_str = fs::read_to_string(config_path)?;
        toml::from_str(&config_str)?
    } else {
        println!("未提供配置文件，使用默认配置");
        Config::default()
    };

    let addr = format!("{}:{}", config.host, config.port);
    let listener = TcpListener::bind(&addr).await?;

    println!("WebSocket 服务器运行在 ws://{}", addr);

    while let Ok((stream, addr)) = listener.accept().await {
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, addr).await {
                eprintln!("处理连接错误: {}", e);
            }
        });
    }

    Ok(())
}
