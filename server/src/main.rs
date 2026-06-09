use futures_util::{SinkExt, StreamExt};
use std::net::SocketAddr;
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::{accept_async, tungstenite::protocol::Message};

async fn handle_connection(
    raw_stream: TcpStream,
    addr: SocketAddr,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    println!("新的 WebSocket 连接: {}", addr);

    let ws_stream = accept_async(raw_stream).await?;
    let (mut ws_sender, mut ws_receiver) = ws_stream.split();

    // 发送欢迎消息
    ws_sender.send(Message::Text("欢迎连接到 WebSocket 服务器!".to_string())).await?;

    while let Some(message) = ws_receiver.next().await {
        match message {
            Ok(msg) => {
                match msg {
                    Message::Text(text) => {
                        println!("收到来自 {} 的消息: {}", addr, text);
                        // 回显消息
                        let response = format!("服务器收到: {}", text);
                        ws_sender.send(Message::Text(response)).await?;
                    }
                    Message::Binary(data) => {
                        println!("收到来自 {} 的二进制数据: {} 字节", addr, data.len());
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

    println!("连接 {} 已关闭", addr);
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let addr = "127.0.0.1:8081";
    let listener = TcpListener::bind(addr).await?;

    println!("WebSocket 服务器运行在 ws://{}", addr);
    println!("使用 client.html 测试连接");

    while let Ok((stream, addr)) = listener.accept().await {
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, addr).await {
                eprintln!("处理连接错误: {}", e);
            }
        });
    }

    Ok(())
}