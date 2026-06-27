mod admin;
mod config;
mod crypto;
mod handler;
mod traffic;

use tokio::net::TcpListener;
use clap::Parser;
use std::fs;
use std::sync::Arc;
use std::time::Duration;
use sysinfo::System;
use config::{Args, Config};
use handler::{handle_connection, AppState};
use redb::Database;

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

    // 3. 初始化 redb 数据库（先尝试打开已有文件，不存在则创建新库）
    println!("Opening redb database at: '{}'", config.redb_path);
    let db = Arc::new(Database::open(&config.redb_path)
        .or_else(|e| match e {
            redb::DatabaseError::Storage(_) => {
                println!("Creating new redb database...");
                Database::create(&config.redb_path)
            }
            other => Err(other),
        })?);
    println!("Redb database opened at: {}", config.redb_path);

    // 4. 从 redb 加载全局累计数据到内存
    let global_data = traffic::load_global_data(&db);
    println!(
        "Loaded global traffic: inbound={}, outbound={}, relay={}",
        global_data.inbound_bytes, global_data.outbound_bytes, global_data.relay_forwarded_bytes
    );

    // 5. 创建应用共享状态，存储已连接用户和管理员配置
    let state = Arc::new(AppState::new(config.admin_user_id.clone(), config.clone(), db.clone()));

    // 将加载的全局数据写入 TrafficStats
    state.traffic.lock().unwrap_or_else(|e| e.into_inner()).set_global(global_data);

    // 6. 启动 flush 定时器（每 config.traffic_flush_interval_secs 秒）
    let flush_state = Arc::clone(&state);
    let flush_interval = Duration::from_secs(config.traffic_flush_interval_secs);
    let _flush_handle = tokio::spawn(async move {
        handle_flush_timer(flush_state, flush_interval).await;
    });

    // 7. 初始化网络监听
    let addr = format!("{}:{}", config.host, config.port);
    let listener = TcpListener::bind(&addr).await?;

    println!("WebSocket server is successfully running on ws://{}", addr);
    if let Some(ref admin_id) = config.admin_user_id {
        println!("Admin user configured: {}", admin_id);
    }
    println!("Redb persistence enabled (flush interval: {}s)", config.traffic_flush_interval_secs);

    // 8. 服务器主循环：持续接受新的连接请求
    while let Ok((stream, addr)) = listener.accept().await {
        let state = Arc::clone(&state);
        // 为每一个新连接创建一个独立的 tokio 任务（轻量级线程）进行处理
        tokio::spawn(async move {
            if let Err(e) = handle_connection(stream, addr, state, config.handshake_timeout_secs).await {
                eprintln!("Error handling connection from {}: {}", addr, e);
            }
        });
    }

    Ok(())
}

/// 定期 flush 定时器，每 flush_interval 执行一次完整落盘
async fn handle_flush_timer(state: Arc<AppState>, flush_interval: Duration) {
    let mut sys = System::new_all();
    sys.refresh_cpu_all();
    sys.refresh_memory();

    loop {
        tokio::time::sleep(flush_interval).await;

        let now = traffic::now_ms();
        let ts_30s = now / 30_000;

        // 从内存中提取 30s 窗口的 delta 和用户流量分布
        let (inbound_delta, outbound_delta, relay_delta);
        let user_traffic_records;
        let global;
        {
            let mut tr = state.traffic.lock().unwrap_or_else(|e| e.into_inner());
            let deltas = tr.take_interval_deltas();
            inbound_delta = deltas.0;
            outbound_delta = deltas.1;
            relay_delta = deltas.2;
            user_traffic_records = tr.take_user_traffic_map();
            global = tr.compute_global();
        }

        // 采集系统指标
        sys.refresh_cpu_all();
        sys.refresh_memory();
        let cpu_percent = sys.global_cpu_usage() as f64;
        let mem_percent = if sys.total_memory() > 0 {
            sys.used_memory() as f64 / sys.total_memory() as f64 * 100.0
        } else {
            0.0
        };

        // 在 spawn_blocking 中执行 redb 写入
        let db = state.db.clone();
        let _ = tokio::task::spawn_blocking(move || {
            if let Err(e) = traffic::perform_flush(
                &db,
                ts_30s,
                inbound_delta,
                outbound_delta,
                relay_delta,
                &user_traffic_records,
                &global,
            ) {
                eprintln!("Redb flush error: {}", e);
            }

            // 写入系统快照
            if let Err(e) = traffic::write_system_stats(&db, ts_30s, cpu_percent, mem_percent) {
                eprintln!("Redb system stats write error: {}", e);
            }
        }).await;
    }
}
