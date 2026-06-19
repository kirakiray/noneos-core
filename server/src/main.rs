mod config;
mod crypto;
mod handler;
mod traffic;

use tokio::net::TcpListener;
use clap::Parser;
use std::fs;
use std::sync::Arc;
use config::{Args, Config};
use handler::{handle_connection, AppState};
use sysinfo::System;

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

    // 4. 创建应用共享状态，存储已连接用户和管理员配置
    let state = Arc::new(AppState::new(config.admin_user_id.clone(), config.clone()));

    // 5. 初始化流量统计落盘任务（如果配置了数据库路径）
    if let Some(ref db_path) = config.traffic_db_path {
        let db_path = db_path.clone();
        let state_clone = Arc::clone(&state);
        let flush_interval = config.traffic_flush_interval_secs;
        tokio::spawn(async move {
            let conn = match traffic::init_db(&db_path) {
                Ok(c) => {
                    println!("Traffic stats persistence initialized: {}", db_path);
                    c
                }
                Err(e) => {
                    eprintln!("Failed to init traffic DB: {}", e);
                    return;
                }
            };

            // 加载初始全局统计数据
            match traffic::load_global_traffic(&conn) {
                Ok(global) => {
                    let mut tr = state_clone.traffic.lock().unwrap();
                    tr.set_global(global);
                    println!("Loaded historical global traffic data");
                }
                Err(e) => {
                    eprintln!("Failed to load global traffic data: {}", e);
                }
            }

            println!("Traffic stats flush task started (interval: {}s)", flush_interval);
            loop {
                tokio::time::sleep(tokio::time::Duration::from_secs(flush_interval)).await;
                let recorded_at = traffic::now_ms();
                
                // 1. 获取会话快照和全局流量
                let (sessions, global) = {
                    let tr = state_clone.traffic.lock().unwrap();
                    (tr.sessions.clone(), tr.global.clone())
                };

                // 2. 保存会话快照
                if !sessions.is_empty() {
                    if let Err(e) = traffic::flush_sessions_to_db(&conn, &sessions, recorded_at) {
                        eprintln!("Failed to flush session traffic snapshots: {}", e);
                    }
                }

                // 3. 保存全局流量
                if let Err(e) = traffic::save_global_traffic(&conn, &global) {
                    eprintln!("Failed to save global traffic stats: {}", e);
                }

                // 4. 采集系统指标（CPU + 内存使用率）
                let mut sys = System::new_all();
                sys.refresh_cpu_all();
                sys.refresh_memory();
                // sysinfo 需要两次 refresh 才能获得有意义的 CPU 差值
                tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                sys.refresh_cpu_all();
                sys.refresh_memory();

                let cpu_count = sys.cpus().len();
                let cpu_sum: f64 = sys.cpus().iter().map(|c| c.cpu_usage() as f64).sum();
                let cpu_avg = if cpu_count > 0 { cpu_sum / cpu_count as f64 } else { 0.0 };

                let total_mem = sys.total_memory();
                let mem_percent = if total_mem > 0 {
                    (sys.used_memory() as f64 / total_mem as f64 * 100.0 * 100.0).round() / 100.0
                } else {
                    0.0
                };

                if let Err(e) = traffic::save_system_stats(&conn, recorded_at, cpu_avg, mem_percent) {
                    eprintln!("Failed to save system stats: {}", e);
                }
            }
        });
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
