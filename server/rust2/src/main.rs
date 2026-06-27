mod admin;
mod config;
mod crypto;
mod db;
mod handler;
mod protocol;
mod state;
mod traffic;

use std::fs;
use std::sync::Arc;
use clap::Parser;
use tokio::net::TcpListener;

use config::{Args, Config};
use state::AppState;

#[tokio::main]
async fn main() {
    // 1. 解析命令行参数
    let args = Args::parse();

    // 2. 加载配置
    let config = if let Some(config_path) = args.config {
        eprintln!("[init] Loading config from {:?}", config_path);
        let config_str = match fs::read_to_string(&config_path) {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[init] Failed to read config file {:?}: {}", config_path, e);
                std::process::exit(1);
            }
        };
        match toml::from_str(&config_str) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[init] Failed to parse config file: {}", e);
                std::process::exit(1);
            }
        }
    } else {
        eprintln!("[init] No config file provided, using default configuration");
        Config::default()
    };

    // 3. 初始化 DB actor（如果配置了数据库路径）
    let db_tx = if let Some(ref db_path) = config.traffic_db_path {
        let (tx, _handle) = db::spawn(db_path.clone());
        eprintln!("[init] DB actor started at {}", db_path);
        // 加载初始流量数据和用户额度
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let _ = tx.send(db::DbCmd::LoadGlobalTraffic { reply: reply_tx });
        match reply_rx.await {
            Ok(Ok((inb, outb, relay, hand))) => {
                eprintln!("[init] Loaded global traffic: in={}, out={}, relay={}, hand={}", inb, outb, relay, hand);
            }
            Ok(Err(e)) => {
                eprintln!("[init] Failed to load global traffic: {} (starting fresh)", e);
            }
            Err(_) => {
                eprintln!("[init] DB actor communication error");
            }
        }

        // 用户转发额度在首次访问时懒加载，此处仅初始化表结构
        Some(tx)
    } else {
        eprintln!("[init] No traffic DB configured (in-memory only)");
        None
    };

    // 4. 创建应用状态
    let state = Arc::new(AppState::new(config.admin_user_id.clone(), config.clone(), db_tx.clone()));

    // 5. 启动流量统计持久化任务
    if let Some(ref db_tx) = db_tx {
        let traffic_handle = traffic::start_persistence_task(
            Arc::clone(&state.traffic),
            db_tx.clone(),
            config.traffic_flush_interval_secs,
        );
        // 确保任务不被 drop（存储但不使用）
        std::mem::forget(traffic_handle);
    }

    // 6. 启动系统统计持久化任务
    if let Some(ref db_tx) = db_tx {
        let db_tx_clone = db_tx.clone();
        tokio::spawn(async move {
            let mut ticker = tokio::time::interval(tokio::time::Duration::from_secs(30));
            ticker.tick().await; // 跳过第一次
            loop {
                ticker.tick().await;
                let (cpu, mem) = admin::get_cpu_mem_usage().await;
                let _ = db_tx_clone.send(db::DbCmd::SaveSystemStats {
                    recorded_at: protocol::now_ms(),
                    cpu, mem,
                });
            }
        });
    }

    // 7. 绑定监听
    let addr = format!("{}:{}", config.host, config.port);
    let listener = match TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("[init] Failed to bind to {}: {}", addr, e);
            std::process::exit(1);
        }
    };

    eprintln!("[init] WebSocket server running on ws://{}", addr);
    eprintln!("[init] Max connections: {}", config.max_connections);
    eprintln!("[init] Max sessions per user: {}", config.max_sessions_per_user);
    if let Some(ref admin_id) = config.admin_user_id {
        eprintln!("[init] Admin: {}", admin_id);
    }
    if config.traffic_db_path.is_some() {
        eprintln!("[init] Traffic persistence: {}s", config.traffic_flush_interval_secs);
    }

    // 8. 优雅关闭信号
    let shutdown_signal = tokio::signal::ctrl_c();

    // 9. 主接受循环
    tokio::select! {
        result = accept_loop(listener, state) => {
            if let Err(e) = result {
                eprintln!("[init] Server error: {}", e);
            }
        }
        _ = shutdown_signal => {
            eprintln!("[init] Received SIGINT, shutting down gracefully...");
        }
    }

    // 10. 优雅关闭：通知 DB actor 退出
    if let Some(db_tx) = &db_tx {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let _ = db_tx.send(db::DbCmd::Shutdown { reply: reply_tx });
        // 等待最多 5 秒
        let _ = tokio::time::timeout(tokio::time::Duration::from_secs(5), reply_rx).await;
    }

    eprintln!("[init] Server stopped");
}

async fn accept_loop(listener: TcpListener, state: Arc<AppState>) -> Result<(), Box<dyn std::error::Error>> {
    loop {
        let (stream, addr) = listener.accept().await?;

        // 快速检查：如果已满则直接拒绝（不阻塞）
        if state.conn_semaphore.available_permits() == 0 {
            eprintln!("[conn] Rejected {} - server full ({} max)", addr, state.config.max_connections);
            drop(stream); // 关闭 TCP 连接
            continue;
        }

        let state = Arc::clone(&state);
        tokio::spawn(async move {
            handler::handle_connection(stream, addr, state).await;
        });
    }
}
