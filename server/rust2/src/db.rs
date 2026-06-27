/// DB actor: 所有 SQLite 操作通过 channel 发送到单个后台线程串行执行。
/// 消除了原代码中 `spawn_blocking` 滥用导致阻塞线程池耗尽的问题。

use rusqlite::Connection;
use tokio::sync::{mpsc, oneshot};
use std::thread;

// ──── 命令枚举 ────

pub enum DbCmd {
    SaveUser {
        user_id: String,
        username: String,
        public_key: String,
        first_seen_at: u64,
        last_seen_at: u64,
    },
    SaveGlobalTraffic {
        inbound_bytes: u64,
        outbound_bytes: u64,
        relay_forwarded_bytes: u64,
        handshake_bytes: u64,
        updated_at: u64,
    },
    LoadGlobalTraffic {
        reply: oneshot::Sender<Result<(u64, u64, u64, u64), String>>,
    },
    FlushSessions {
        snapshot: Vec<SessionSnapshot>,
        recorded_at: u64,
    },
    SaveSessionFinal {
        snapshot: SessionSnapshot,
    },
    SaveUserRelayQuota {
        user_id: String,
        quota_bytes: u64,
        used_bytes: u64,
        updated_at: u64,
    },
    SaveSystemStats {
        recorded_at: u64,
        cpu: f64,
        mem: f64,
    },
    QueryUsersPaginated {
        page: u32,
        page_size: u32,
        reply: oneshot::Sender<Result<(Vec<serde_json::Value>, u32), String>>,
    },
    QueryTrafficHistoryPaginated {
        from_ms: i64,
        to_ms: i64,
        user_id: Option<String>,
        page: u32,
        page_size: u32,
        reply: oneshot::Sender<Result<(Vec<serde_json::Value>, u32), String>>,
    },
    QueryTrafficHistoryTotals {
        from_ms: i64,
        to_ms: i64,
        user_id: Option<String>,
        reply: oneshot::Sender<Result<(u64, u64, u64, u64), String>>,
    },
    QuerySystemStatsHistory {
        limit: usize,
        reply: oneshot::Sender<Result<Vec<(u64, f64, f64)>, String>>,
    },
    Shutdown {
        reply: oneshot::Sender<()>,
    },
}

#[derive(Debug, Clone)]
pub struct SessionSnapshot {
    pub user_id: String,
    pub session_id: String,
    pub username: String,
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
    pub handshake_bytes: u64,
}

/// 创建 DB actor，返回发送端和 JoinHandle
pub fn spawn(path: String) -> (mpsc::UnboundedSender<DbCmd>, thread::JoinHandle<()>) {
    let (tx, mut rx) = mpsc::unbounded_channel::<DbCmd>();

    let handle = thread::Builder::new()
        .name("db-actor".into())
        .spawn(move || {
            // 初始化数据库连接
            let conn = match init_db(&path) {
                Ok(c) => c,
                Err(e) => {
                    eprintln!("[db] Failed to open database at {}: {}", path, e);
                    // 即使初始化失败也要继续消费命令（返回错误）
                    return;
                }
            };

            while let Some(cmd) = rx.blocking_recv() {
                match cmd {
                    DbCmd::SaveUser { user_id, username, public_key, first_seen_at, last_seen_at } => {
                        let _ = conn.execute(
                            "INSERT INTO users (user_id, username, public_key, first_seen_at, last_seen_at)
                             VALUES (?1, ?2, ?3, ?4, ?5)
                             ON CONFLICT(user_id) DO UPDATE SET
                                username = excluded.username,
                                public_key = excluded.public_key,
                                last_seen_at = excluded.last_seen_at",
                            rusqlite::params![user_id, username, public_key, first_seen_at as i64, last_seen_at as i64],
                        );
                    }
                    DbCmd::SaveGlobalTraffic { inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes, updated_at } => {
                        let _ = conn.execute(
                            "INSERT INTO global_traffic (id, inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes, updated_at)
                             VALUES (1, ?1, ?2, ?3, ?4, ?5)
                             ON CONFLICT(id) DO UPDATE SET
                                inbound_bytes = excluded.inbound_bytes,
                                outbound_bytes = excluded.outbound_bytes,
                                relay_forwarded_bytes = excluded.relay_forwarded_bytes,
                                handshake_bytes = excluded.handshake_bytes,
                                updated_at = excluded.updated_at",
                            rusqlite::params![inbound_bytes as i64, outbound_bytes as i64, relay_forwarded_bytes as i64, handshake_bytes as i64, updated_at as i64],
                        );
                    }
                    DbCmd::LoadGlobalTraffic { reply } => {
                        let result = conn.query_row(
                            "SELECT inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes FROM global_traffic WHERE id = 1",
                            [],
                            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)? as u64, row.get::<_, i64>(3)? as u64)),
                        );
                        let _ = reply.send(result.map_err(|e| e.to_string()));
                    }
                    DbCmd::FlushSessions { snapshot, recorded_at } => {
                        if snapshot.is_empty() { continue; }
                        let _ = flush_sessions_inner(&conn, &snapshot, recorded_at);
                    }
                    DbCmd::SaveSessionFinal { snapshot } => {
                        let v = vec![snapshot];
                        let _ = flush_sessions_inner(&conn, &v, crate::protocol::now_ms());
                    }
                    DbCmd::SaveUserRelayQuota { user_id, quota_bytes, used_bytes, updated_at } => {
                        let _ = conn.execute(
                            "INSERT INTO user_relay_quotas (user_id, quota_bytes, used_bytes, updated_at)
                             VALUES (?1, ?2, ?3, ?4)
                             ON CONFLICT(user_id) DO UPDATE SET
                                quota_bytes = excluded.quota_bytes,
                                used_bytes = excluded.used_bytes,
                                updated_at = excluded.updated_at",
                            rusqlite::params![user_id, quota_bytes as i64, used_bytes as i64, updated_at as i64],
                        );
                    }
                    DbCmd::SaveSystemStats { recorded_at, cpu, mem } => {
                        let _ = conn.execute(
                            "INSERT INTO system_stats (recorded_at, cpu_usage_percent, memory_usage_percent) VALUES (?1, ?2, ?3)",
                            rusqlite::params![recorded_at as i64, cpu, mem],
                        );
                    }
                    DbCmd::QueryUsersPaginated { page, page_size, reply } => {
                        let result = query_users_paginated_inner(&conn, page, page_size);
                        let _ = reply.send(result);
                    }
                    DbCmd::QueryTrafficHistoryPaginated { from_ms, to_ms, user_id, page, page_size, reply } => {
                        let result = query_traffic_history_paginated_inner(&conn, from_ms, to_ms, user_id.as_deref(), page, page_size);
                        let _ = reply.send(result);
                    }
                    DbCmd::QueryTrafficHistoryTotals { from_ms, to_ms, user_id, reply } => {
                        let result = query_traffic_history_totals_inner(&conn, from_ms, to_ms, user_id.as_deref());
                        let _ = reply.send(result);
                    }
                    DbCmd::QuerySystemStatsHistory { limit, reply } => {
                        let result = query_system_stats_history_inner(&conn, limit);
                        let _ = reply.send(result);
                    }
                    DbCmd::Shutdown { reply } => {
                        let _ = reply.send(());
                        break;
                    }
                }
            }
            eprintln!("[db] Actor shut down");
        })
        .expect("Failed to spawn db actor thread");

    (tx, handle)
}

// ──── 内部函数：在 actor 线程中调用 ────

fn init_db(path: &str) -> Result<Connection, String> {
    let conn = Connection::open(path).map_err(|e| e.to_string())?;
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS traffic_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at INTEGER NOT NULL,
            user_id TEXT NOT NULL,
            session_id TEXT NOT NULL,
            username TEXT NOT NULL DEFAULT '',
            inbound_bytes INTEGER NOT NULL DEFAULT 0,
            outbound_bytes INTEGER NOT NULL DEFAULT 0,
            relay_forwarded_bytes INTEGER NOT NULL DEFAULT 0,
            handshake_bytes INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_ts_recorded ON traffic_snapshots(recorded_at);
        CREATE INDEX IF NOT EXISTS idx_ts_user ON traffic_snapshots(user_id);
        
        CREATE TABLE IF NOT EXISTS global_traffic (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            inbound_bytes INTEGER NOT NULL DEFAULT 0,
            outbound_bytes INTEGER NOT NULL DEFAULT 0,
            relay_forwarded_bytes INTEGER NOT NULL DEFAULT 0,
            handshake_bytes INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL
        );
        
        CREATE TABLE IF NOT EXISTS system_stats (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            recorded_at INTEGER NOT NULL,
            cpu_usage_percent REAL NOT NULL,
            memory_usage_percent REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ss_recorded ON system_stats(recorded_at);
        
        CREATE TABLE IF NOT EXISTS users (
            user_id TEXT PRIMARY KEY,
            username TEXT NOT NULL,
            public_key TEXT NOT NULL,
            first_seen_at INTEGER NOT NULL,
            last_seen_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);

        CREATE TABLE IF NOT EXISTS user_relay_quotas (
            user_id TEXT PRIMARY KEY,
            quota_bytes INTEGER NOT NULL DEFAULT 0,
            used_bytes INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );",
    ).map_err(|e| e.to_string())?;
    Ok(conn)
}

fn flush_sessions_inner(conn: &Connection, snapshots: &[SessionSnapshot], recorded_at: u64) -> Result<(), String> {
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO traffic_snapshots (recorded_at, user_id, session_id, username, inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        ).map_err(|e| e.to_string())?;
        for s in snapshots {
            stmt.execute(rusqlite::params![
                recorded_at as i64, s.user_id, s.session_id, s.username,
                s.inbound_bytes as i64, s.outbound_bytes as i64,
                s.relay_forwarded_bytes as i64, s.handshake_bytes as i64,
            ]).map_err(|e| e.to_string())?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

fn query_users_paginated_inner(conn: &Connection, page: u32, page_size: u32) -> Result<(Vec<serde_json::Value>, u32), String> {
    let total: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))
        .map_err(|e| e.to_string())?;
    let total = total.max(0) as u32;
    let page = page.max(1) as i64;
    let page_size = (page_size.clamp(1, 500)) as i64;
    let offset = (page - 1) * page_size;
    if offset >= total as i64 {
        return Ok((Vec::new(), total));
    }
    let mut stmt = conn.prepare(
        "SELECT user_id, username, public_key, first_seen_at, last_seen_at FROM users ORDER BY last_seen_at DESC LIMIT ?1 OFFSET ?2"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![page_size, offset], |row| {
        Ok(serde_json::json!({
            "userId": row.get::<_, String>(0)?,
            "username": row.get::<_, String>(1)?,
            "publicKey": row.get::<_, String>(2)?,
            "firstSeenAt": row.get::<_, i64>(3)?,
            "lastSeenAt": row.get::<_, i64>(4)?,
        }))
    }).map_err(|e| e.to_string())?;
    let mut results = Vec::new();
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok((results, total))
}

fn count_traffic_history_inner(conn: &Connection, from_ms: i64, to_ms: i64, user_id: Option<&str>) -> Result<u32, String> {
    let count: i64 = if let Some(uid) = user_id {
        conn.query_row(
            "SELECT COUNT(*) FROM traffic_snapshots WHERE recorded_at >= ?1 AND recorded_at <= ?2 AND user_id = ?3",
            rusqlite::params![from_ms, to_ms, uid],
            |row| row.get(0),
        )
    } else {
        conn.query_row(
            "SELECT COUNT(*) FROM traffic_snapshots WHERE recorded_at >= ?1 AND recorded_at <= ?2",
            rusqlite::params![from_ms, to_ms],
            |row| row.get(0),
        )
    }.map_err(|e| e.to_string())?;
    Ok(count.max(0) as u32)
}

fn query_traffic_history_paginated_inner(
    conn: &Connection, from_ms: i64, to_ms: i64, user_id: Option<&str>,
    page: u32, page_size: u32,
) -> Result<(Vec<serde_json::Value>, u32), String> {
    let total = count_traffic_history_inner(conn, from_ms, to_ms, user_id)?;
    let page = page.max(1) as i64;
    let page_size = (page_size.clamp(1, 500)) as i64;
    let offset = (page - 1) * page_size;
    if offset >= total as i64 {
        return Ok((Vec::new(), total));
    }

    let sql = if user_id.is_some() {
        "SELECT recorded_at, user_id, session_id, username, inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes
         FROM traffic_snapshots
         WHERE recorded_at >= ?1 AND recorded_at <= ?2 AND user_id = ?3
         ORDER BY recorded_at DESC, id DESC
         LIMIT ?4 OFFSET ?5"
    } else {
        "SELECT recorded_at, user_id, session_id, username, inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes
         FROM traffic_snapshots
         WHERE recorded_at >= ?1 AND recorded_at <= ?2
         ORDER BY recorded_at DESC, id DESC
         LIMIT ?3 OFFSET ?4"
    };

    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;

    let results = if let Some(uid) = user_id {
        let rows = stmt.query_map(rusqlite::params![from_ms, to_ms, uid, page_size, offset], |row| {
            row_to_traffic_json(row)
        }).map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for row in rows {
            v.push(row.map_err(|e| e.to_string())?);
        }
        v
    } else {
        let rows = stmt.query_map(rusqlite::params![from_ms, to_ms, page_size, offset], |row| {
            row_to_traffic_json(row)
        }).map_err(|e| e.to_string())?;
        let mut v = Vec::new();
        for row in rows {
            v.push(row.map_err(|e| e.to_string())?);
        }
        v
    };

    Ok((results, total))
}

fn query_traffic_history_totals_inner(
    conn: &Connection, from_ms: i64, to_ms: i64, user_id: Option<&str>,
) -> Result<(u64, u64, u64, u64), String> {
    let result = if let Some(uid) = user_id {
        conn.query_row(
            "SELECT COALESCE(SUM(inbound_bytes), 0), COALESCE(SUM(outbound_bytes), 0),
                    COALESCE(SUM(relay_forwarded_bytes), 0), COALESCE(SUM(handshake_bytes), 0)
             FROM traffic_snapshots WHERE recorded_at >= ?1 AND recorded_at <= ?2 AND user_id = ?3",
            rusqlite::params![from_ms, to_ms, uid],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)? as u64, row.get::<_, i64>(3)? as u64)),
        )
    } else {
        conn.query_row(
            "SELECT COALESCE(SUM(inbound_bytes), 0), COALESCE(SUM(outbound_bytes), 0),
                    COALESCE(SUM(relay_forwarded_bytes), 0), COALESCE(SUM(handshake_bytes), 0)
             FROM traffic_snapshots WHERE recorded_at >= ?1 AND recorded_at <= ?2",
            rusqlite::params![from_ms, to_ms],
            |row| Ok((row.get::<_, i64>(0)? as u64, row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)? as u64, row.get::<_, i64>(3)? as u64)),
        )
    }.map_err(|e| e.to_string())?;
    Ok(result)
}

fn query_system_stats_history_inner(conn: &Connection, limit: usize) -> Result<Vec<(u64, f64, f64)>, String> {
    let mut stmt = conn.prepare(
        "SELECT recorded_at, cpu_usage_percent, memory_usage_percent FROM system_stats ORDER BY recorded_at DESC LIMIT ?1"
    ).map_err(|e| e.to_string())?;
    let rows = stmt.query_map(rusqlite::params![limit as i64], |row| {
        Ok((row.get::<_, i64>(0)? as u64, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?))
    }).map_err(|e| e.to_string())?;
    let mut results: Vec<(u64, f64, f64)> = Vec::with_capacity(limit);
    for row in rows {
        results.push(row.map_err(|e| e.to_string())?);
    }
    Ok(results)
}

fn row_to_traffic_json(row: &rusqlite::Row<'_>) -> rusqlite::Result<serde_json::Value> {
    Ok(serde_json::json!({
        "recordedAt": row.get::<_, i64>(0)?,
        "userId": row.get::<_, String>(1)?,
        "sessionId": row.get::<_, String>(2)?,
        "username": row.get::<_, String>(3)?,
        "inboundBytes": row.get::<_, i64>(4)?,
        "outboundBytes": row.get::<_, i64>(5)?,
        "relayForwardedBytes": row.get::<_, i64>(6)?,
        "handshakeBytes": row.get::<_, i64>(7)?,
    }))
}
