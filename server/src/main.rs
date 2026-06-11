mod config;
mod crypto;
mod handler;

use tokio::net::TcpListener;
use clap::Parser;
use std::fs;
use config::{Args, Config};
use handler::handle_connection;

/// WebSocket 服务器主入口
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 解析命令行参数
    let args = Args::parse();

    // 加载配置
    let config = if let Some(config_path) = args.config {
        println!("Loading configuration from {:?}...", config_path);
        let config_str = fs::read_to_string(config_path)?;
        toml::from_str(&config_str)?
    } else {
        println!("No config file provided, using default configuration");
        Config::default()
    };

    // 绑定监听地址
    let addr = format!("{}:{}", config.host, config.port);
    let listener = TcpListener::bind(&addr).await?;

    println!("WebSocket server is running on ws://{}", addr);

    // 接受并处理连接
    while let Ok((stream, addr)) = listener.accept().await {
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, addr).await {
                eprintln!("Error handling connection: {}", e);
            }
        });
    }

    Ok(())
}
