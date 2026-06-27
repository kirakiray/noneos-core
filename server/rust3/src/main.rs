mod admin;
mod config;
mod crypto;
mod handler;
mod traffic;
mod db_actor;

use tokio::net::TcpListener;
use clap::Parser;
use std::fs;
use std::sync::Arc;
use tokio::sync::mpsc;
use config::{Args, Config};
use handler::{handle_connection, AppState};
use db_actor::{DbActor, DbCommand};

/// WebSocket 服务器主入口函数
/// 使用 tokio 运行时驱动异步 IO
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // 1. 解析命令行参数
    let args = Args::parse();

    // 2. 加载配置信息
    let config = if let Some(config_path) = args.config {
        println!("Loading configuration from {:?}...", config_path);
        let config_str = fs::read_to_string(config_path)?;
        toml::from_str(&config_str)?
    } else {
        println!("No config file provided, using default configuration");
        Config::default()
    };

    // 3. 初始化数据库 Actor（如果配置了数据库路径）
    let (db_tx, initial_global, initial_quotas) = if let Some(ref db_path) = config.traffic_db_path {
        let (tx, rx) = mpsc::channel::<DbCommand>(1024);
        let db_path_clone = db_path.clone();
        
        // 我们在主线程阻塞初始化以获取历史数据
        let (actor, global, quotas) = DbActor::new(&db_path_clone, rx)?;
        
        // 启动 DB Actor
        tokio::task::spawn_blocking(move || {
            println!("Database Actor started successfully.");
            actor.run();
        });
        (Some(tx), Some(global), Some(quotas))
    } else {
        (None, None, None)
    };

    // 4. 创建应用共享状态，存储已连接用户和管理员配置
    let state = Arc::new(AppState::new(config.admin_user_id.clone(), config.clone(), db_tx));

    // 如果有历史数据，则加载到状态中
    if let Some(global) = initial_global {
        let mut tr = state.traffic.lock().unwrap();
        tr.set_global(global);
    }
    if let Some(quotas) = initial_quotas {
        for (user_id, quota) in quotas {
            state.user_quotas.insert(user_id, quota);
        }
        println!("Historical traffic data and quotas loaded");
    }

    // 5. 初始化流量统计落盘任务（如果配置了数据库路径）
    if config.traffic_db_path.is_some() {
        traffic::start_persistence_task(
            Arc::clone(&state),
            config.traffic_flush_interval_secs,
        );
    }

    // 6. 初始化网络监听
    // 将主机地址和端口拼接并绑定到 TCP 端口
    let addr = format!("{}:{}", config.host, config.port);
    let listener = TcpListener::bind(&addr).await?;

    println!("WebSocket server is successfully running on ws://{}", addr);
    if let Some(ref admin_id) = config.admin_user_id {
        println!("Admin user configured: {}", admin_id);
    }

    if config.traffic_db_path.is_some() {
        println!("Traffic stats persistence enabled (flush interval: {}s)", config.traffic_flush_interval_secs);
    } else {
        println!("Traffic stats persistence disabled (in-memory only)");
    }

    // 7. 服务器主循环：持续接受新的连接请求
    while let Ok((stream, addr)) = listener.accept().await {
        let state = Arc::clone(&state);
        // 为每一个新连接创建一个独立的 tokio 任务（轻量级线程）进行处理
        // 这样可以实现高并发，一个连接的阻塞或处理不会影响其他连接
        tokio::spawn(async move {
            // 调用 handler 模块中的业务逻辑函数
            if let Err(e) = handle_connection(stream, addr, state, config.handshake_timeout_secs).await {
                eprintln!("Error handling connection from {}: {}", addr, e);
            }
        });
    }

    Ok(())
}
