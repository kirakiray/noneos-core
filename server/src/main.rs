mod config;
mod crypto;
mod handler;

use tokio::net::TcpListener;
use clap::Parser;
use std::fs;
use std::sync::Arc;
use tokio::sync::Mutex;
use config::{Args, Config};
use handler::{handle_connection, AppState};

/// WebSocket 服务器主入口函数
/// 使用 tokio 运行时驱动异步 IO
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. 解析命令行参数（例如：server --config config.toml）
    let args = Args::parse();

    // 2. 加载配置信息
    // 优先从指定的配置文件加载，否则使用代码中的默认配置
    let config = if let Some(config_path) = args.config {
        println!("Loading configuration from {:?}...", config_path);
        let config_str = fs::read_to_string(config_path)?;
        toml::from_str(&config_str)?
    } else {
        println!("No config file provided, using default configuration");
        Config::default()
    };

    // 3. 创建应用共享状态，存储已连接用户和管理员配置
    let state = Arc::new(Mutex::new(AppState::new(config.admin_user_id.clone())));

    // 4. 初始化网络监听
    // 将主机地址和端口拼接并绑定到 TCP 端口
    let addr = format!("{}:{}", config.host, config.port);
    let listener = TcpListener::bind(&addr).await?;

    println!("WebSocket server is successfully running on ws://{}", addr);
    if let Some(ref admin_id) = config.admin_user_id {
        println!("Admin user configured: {}", admin_id);
    }

    // 5. 服务器主循环：持续接受新的连接请求
    while let Ok((stream, addr)) = listener.accept().await {
        let state = Arc::clone(&state);
        // 为每一个新连接创建一个独立的 tokio 任务（轻量级线程）进行处理
        // 这样可以实现高并发，一个连接的阻塞或处理不会影响其他连接
        tokio::spawn(async move {
            // 调用 handler 模块中的业务逻辑函数
            if let Err(e) = handle_connection(stream, addr, state).await {
                eprintln!("Error handling connection from {}: {}", addr, e);
            }
        });
    }

    Ok(())
}
