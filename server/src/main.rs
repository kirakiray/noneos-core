mod config;
mod crypto;
mod handler;

use tokio::net::TcpListener;
use clap::Parser;
use std::fs;
use config::{Args, Config};
use handler::handle_connection;

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
