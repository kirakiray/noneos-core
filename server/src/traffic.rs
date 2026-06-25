use std::collections::{HashMap, VecDeque};
use serde::Serialize;
use rusqlite::Connection;
use sysinfo::System;
use std::sync::Arc;
use tokio::time::{sleep, Duration};

/// Per-session traffic counters
#[derive(Debug, Clone, Serialize)]
pub struct SessionTraffic {
    pub conn_key: String,
    pub user_id: String,
    pub session_id: String,
    pub username: String,
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
    pub handshake_bytes: u64,
    pub created_at: u64,
    pub last_activity_at: u64,
}

/// Per-user aggregated traffic summary
#[derive(Debug, Clone, Serialize)]
pub struct UserTrafficSummary {
    pub user_id: String,
    pub username: String,
    pub session_count: usize,
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
    pub handshake_bytes: u64,
}

/// Global traffic totals
#[derive(Debug, Clone, Serialize, Default)]
pub struct GlobalTraffic {
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
    pub handshake_bytes: u64,
}

/// Minute-level traffic bucket for time distribution
#[derive(Debug, Clone, Serialize)]
pub struct MinuteBucket {
    pub minute_epoch: u64,
    pub inbound_bytes: u64,
    pub outbound_bytes: u64,
    pub relay_forwarded_bytes: u64,
}

/// Response struct for the admin `get_traffic_stats` command
#[derive(Debug, Clone, Serialize)]
pub struct TrafficStatsResponse {
    pub global: GlobalTraffic,
    pub users: Vec<UserTrafficSummary>,
    pub time_distribution: Vec<MinuteBucket>,
    pub user_count: usize, // total number of unique online users (before limit)
}

/// Traffic statistics container — lives inside AppState
pub struct TrafficStats {
    pub sessions: HashMap<String, SessionTraffic>,
    pub minute_buckets: VecDeque<MinuteBucket>,
    pub global: GlobalTraffic, // Incremental global stats
    current_minute_epoch: u64,
    minute_window: usize,
}

impl TrafficStats {
    pub fn new(minute_window: usize) -> Self {
        Self {
            sessions: HashMap::new(),
            minute_buckets: VecDeque::with_capacity(minute_window),
            global: GlobalTraffic::default(),
            current_minute_epoch: 0,
            minute_window,
        }
    }

    /// Set initial global traffic (usually loaded from DB)
    pub fn set_global(&mut self, global: GlobalTraffic) {
        self.global = global;
    }

    /// Register a new session's traffic counter
    pub fn register_session(
        &mut self,
        conn_key: &str,
        user_id: &str,
        session_id: &str,
        username: &str,
        now_ms: u64,
    ) {
        self.sessions.entry(conn_key.to_string()).or_insert(SessionTraffic {
            conn_key: conn_key.to_string(),
            user_id: user_id.to_string(),
            session_id: session_id.to_string(),
            username: username.to_string(),
            inbound_bytes: 0,
            outbound_bytes: 0,
            relay_forwarded_bytes: 0,
            handshake_bytes: 0,
            created_at: now_ms,
            last_activity_at: now_ms,
        });
    }

    /// Remove a session and return its final counters
    pub fn remove_session(&mut self, conn_key: &str) -> Option<SessionTraffic> {
        self.sessions.remove(conn_key)
    }

    /// Count inbound bytes (client → server)
    pub fn add_inbound(&mut self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, bytes, 0, 0);
        self.global.inbound_bytes = self.global.inbound_bytes.saturating_add(bytes);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.inbound_bytes = s.inbound_bytes.saturating_add(bytes);
            s.last_activity_at = now_ms;
        }
    }

    /// Count outbound bytes (server → client)
    pub fn add_outbound(&mut self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, 0, bytes, 0);
        self.global.outbound_bytes = self.global.outbound_bytes.saturating_add(bytes);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.outbound_bytes = s.outbound_bytes.saturating_add(bytes);
            s.last_activity_at = now_ms;
        }
    }

    /// Count relay-forwarded bytes (this session relayed data TO another session)
    pub fn add_relay_forwarded(&mut self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, 0, 0, bytes);
        self.global.relay_forwarded_bytes = self.global.relay_forwarded_bytes.saturating_add(bytes);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.relay_forwarded_bytes = s.relay_forwarded_bytes.saturating_add(bytes);
            s.last_activity_at = now_ms;
        }
    }

    /// Count handshake bytes
    pub fn add_handshake(&mut self, conn_key: &str, bytes: u64, _now_ms: u64) {
        self.global.handshake_bytes = self.global.handshake_bytes.saturating_add(bytes);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.handshake_bytes = s.handshake_bytes.saturating_add(bytes);
        }
    }

    /// Update the minute-level sliding window
    fn update_minute_bucket(&mut self, now_ms: u64, inbound: u64, outbound: u64, relay: u64) {
        let minute_epoch = now_ms / 60_000;
        if minute_epoch != self.current_minute_epoch {
            // Fill gap minutes if we skipped multiple minutes
            if let Some(last) = self.minute_buckets.back() {
                for m in (last.minute_epoch + 1)..minute_epoch {
                    if self.minute_buckets.len() >= self.minute_window {
                        self.minute_buckets.pop_front();
                    }
                    self.minute_buckets.push_back(MinuteBucket {
                        minute_epoch: m,
                        inbound_bytes: 0,
                        outbound_bytes: 0,
                        relay_forwarded_bytes: 0,
                    });
                }
            }
            self.current_minute_epoch = minute_epoch;
        }

        // Find or create the bucket for this minute
        // Since we usually update the last bucket, we search from the back
        if let Some(bucket) = self
            .minute_buckets
            .iter_mut()
            .rev()
            .find(|b| b.minute_epoch == minute_epoch)
        {
            bucket.inbound_bytes = bucket.inbound_bytes.saturating_add(inbound);
            bucket.outbound_bytes = bucket.outbound_bytes.saturating_add(outbound);
            bucket.relay_forwarded_bytes = bucket.relay_forwarded_bytes.saturating_add(relay);
        } else {
            if self.minute_buckets.len() >= self.minute_window {
                self.minute_buckets.pop_front();
            }
            self.minute_buckets.push_back(MinuteBucket {
                minute_epoch,
                inbound_bytes: inbound,
                outbound_bytes: outbound,
                relay_forwarded_bytes: relay,
            });
        }
    }

    /// Compute global totals (now just returns the cached incremental value)
    pub fn compute_global(&self) -> GlobalTraffic {
        self.global.clone()
    }

    /// Compute per-user aggregated summaries, sorted by inbound desc
    pub fn compute_user_summaries(&self) -> Vec<UserTrafficSummary> {
        let mut user_map: HashMap<String, UserTrafficSummary> = HashMap::new();
        for s in self.sessions.values() {
            let entry = user_map.entry(s.user_id.clone()).or_insert(UserTrafficSummary {
                user_id: s.user_id.clone(),
                username: String::new(),
                session_count: 0,
                inbound_bytes: 0,
                outbound_bytes: 0,
                relay_forwarded_bytes: 0,
                handshake_bytes: 0,
            });
            entry.username = s.username.clone();
            entry.session_count = entry.session_count.saturating_add(1);
            entry.inbound_bytes = entry.inbound_bytes.saturating_add(s.inbound_bytes);
            entry.outbound_bytes = entry.outbound_bytes.saturating_add(s.outbound_bytes);
            entry.relay_forwarded_bytes =
                entry.relay_forwarded_bytes.saturating_add(s.relay_forwarded_bytes);
            entry.handshake_bytes =
                entry.handshake_bytes.saturating_add(s.handshake_bytes);
        }
        let mut users: Vec<UserTrafficSummary> = user_map.into_values().collect();
        users.sort_by(|a, b| b.inbound_bytes.cmp(&a.inbound_bytes));
        users
    }

    /// Get the current minute-level time distribution
    pub fn get_time_distribution(&self) -> Vec<MinuteBucket> {
        self.minute_buckets.iter().cloned().collect()
    }

    /// Build the full response for the admin command, optionally limited to top N users
    pub fn build_response(&self, limit: Option<usize>) -> TrafficStatsResponse {
        let all_users = self.compute_user_summaries();
        let user_count = all_users.len();
        let users = if let Some(l) = limit {
            all_users.into_iter().take(l).collect()
        } else {
            all_users
        };
        TrafficStatsResponse {
            global: self.compute_global(),
            users,
            time_distribution: self.get_time_distribution(),
            user_count,
        }
    }
}

/// Get current timestamp in milliseconds
pub fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

/// Get message byte size for counting
pub fn message_byte_size(msg: &tungstenite::Message) -> usize {
    match msg {
        tungstenite::Message::Text(s) => s.len(),
        tungstenite::Message::Binary(d) => d.len(),
        tungstenite::Message::Ping(d) | tungstenite::Message::Pong(d) => d.len(),
        tungstenite::Message::Close(_) => 4,
        tungstenite::Message::Frame(_) => 0,
    }
}

// ===== SQLite Persistence =====

/// Initialize the SQLite database and create tables if needed
pub fn init_db(db_path: &str) -> Result<Connection, rusqlite::Error> {
    let conn = Connection::open(db_path)?;
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
        CREATE INDEX IF NOT EXISTS idx_users_last_seen ON users(last_seen_at);",
    )?;
    Ok(conn)
}

/// User record for management
#[derive(Debug, Clone, Serialize)]
pub struct UserRecord {
    pub user_id: String,
    pub username: String,
    pub public_key: String,
    pub first_seen_at: u64,
    pub last_seen_at: u64,
}

/// Save or update a user record in the DB
pub fn save_user(conn: &Connection, user: &UserRecord) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO users (user_id, username, public_key, first_seen_at, last_seen_at)
         VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(user_id) DO UPDATE SET
            username = excluded.username,
            public_key = excluded.public_key,
            last_seen_at = excluded.last_seen_at",
        rusqlite::params![
            user.user_id,
            user.username,
            user.public_key,
            user.first_seen_at as i64,
            user.last_seen_at as i64,
        ],
    )?;
    Ok(())
}

/// Count total number of users in the DB
pub fn count_users(conn: &Connection) -> Result<u32, rusqlite::Error> {
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM users", [], |row| row.get(0))?;
    Ok(count as u32)
}

/// Query all users from the DB with pagination
pub fn query_users_paginated(
    conn: &Connection,
    page: u32,
    page_size: u32,
) -> Result<(Vec<serde_json::Value>, u32), rusqlite::Error> {
    let total = count_users(conn)?;
    let page = page.max(1) as i64;
    let page_size = page_size.max(1).min(500) as i64;
    let offset = (page - 1) * page_size;

    if offset >= total as i64 {
        return Ok((Vec::new(), total));
    }

    let mut stmt = conn.prepare(
        "SELECT user_id, username, public_key, first_seen_at, last_seen_at
         FROM users
         ORDER BY last_seen_at DESC
         LIMIT ?1 OFFSET ?2"
    )?;

    let rows = stmt.query_map(rusqlite::params![page_size, offset], |row| {
        Ok(serde_json::json!({
            "userId": row.get::<_, String>(0)?,
            "username": row.get::<_, String>(1)?,
            "publicKey": row.get::<_, String>(2)?,
            "firstSeenAt": row.get::<_, i64>(3)?,
            "lastSeenAt": row.get::<_, i64>(4)?,
        }))
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok((results, total))
}

/// A single system stats record (CPU + memory snapshot)
#[derive(Debug, Clone, Serialize)]
pub struct SystemStatsRecord {
    pub recorded_at: u64,
    pub cpu_usage_percent: f64,
    pub memory_usage_percent: f64,
}

/// Save one system stats snapshot to DB
pub fn save_system_stats(conn: &Connection, recorded_at: u64, cpu_percent: f64, mem_percent: f64) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO system_stats (recorded_at, cpu_usage_percent, memory_usage_percent) VALUES (?1, ?2, ?3)",
        rusqlite::params![recorded_at as i64, cpu_percent, mem_percent],
    )?;
    Ok(())
}

/// Query the most recent system stats records (limited to `limit` rows)
pub fn query_system_stats_history(conn: &Connection, limit: usize) -> Result<Vec<SystemStatsRecord>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT recorded_at, cpu_usage_percent, memory_usage_percent FROM system_stats ORDER BY recorded_at DESC LIMIT ?1"
    )?;
    let rows = stmt.query_map(rusqlite::params![limit as i64], |row| {
        Ok(SystemStatsRecord {
            recorded_at: row.get::<_, i64>(0)? as u64,
            cpu_usage_percent: row.get::<_, f64>(1)?,
            memory_usage_percent: row.get::<_, f64>(2)?,
        })
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    results.reverse(); // 按时间升序返回，方便前端折线图
    Ok(results)
}

/// Load global traffic from DB
pub fn load_global_traffic(conn: &Connection) -> Result<GlobalTraffic, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes FROM global_traffic WHERE id = 1"
    )?;
    let res = stmt.query_row([], |row| {
        Ok(GlobalTraffic {
            inbound_bytes: row.get::<_, i64>(0)? as u64,
            outbound_bytes: row.get::<_, i64>(1)? as u64,
            relay_forwarded_bytes: row.get::<_, i64>(2)? as u64,
            handshake_bytes: row.get::<_, i64>(3)? as u64,
        })
    });

    match res {
        Ok(g) => Ok(g),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(GlobalTraffic::default()),
        Err(e) => Err(e),
    }
}

/// Persist global traffic to DB
pub fn save_global_traffic(conn: &Connection, global: &GlobalTraffic) -> Result<(), rusqlite::Error> {
    conn.execute(
        "INSERT INTO global_traffic (id, inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes, updated_at)
         VALUES (1, ?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(id) DO UPDATE SET
            inbound_bytes = excluded.inbound_bytes,
            outbound_bytes = excluded.outbound_bytes,
            relay_forwarded_bytes = excluded.relay_forwarded_bytes,
            handshake_bytes = excluded.handshake_bytes,
            updated_at = excluded.updated_at",
        rusqlite::params![
            global.inbound_bytes as i64,
            global.outbound_bytes as i64,
            global.relay_forwarded_bytes as i64,
            global.handshake_bytes as i64,
            now_ms() as i64,
        ],
    )?;
    Ok(())
}

/// Flush all current session counters to SQLite as a snapshot
pub fn flush_sessions_to_db(
    conn: &Connection,
    sessions: &HashMap<String, SessionTraffic>,
    recorded_at: u64,
) -> Result<(), rusqlite::Error> {
    if sessions.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO traffic_snapshots (recorded_at, user_id, session_id, username, inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        )?;
        for s in sessions.values() {
            stmt.execute(rusqlite::params![
                recorded_at as i64,
                s.user_id,
                s.session_id,
                s.username,
                s.inbound_bytes as i64,
                s.outbound_bytes as i64,
                s.relay_forwarded_bytes as i64,
                s.handshake_bytes as i64,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Save a final snapshot for a closing session
pub fn save_final_session_stats(
    db_path: &Option<String>,
    session: &SessionTraffic,
) {
    if let Some(path) = db_path {
        let session_clone = session.clone();
        let path_clone = path.clone();
        // Spawning a task to avoid blocking the connection handler's cleanup
        tokio::spawn(async move {
            if let Ok(conn) = Connection::open(path_clone) {
                let mut sessions = HashMap::new();
                sessions.insert(session_clone.conn_key.clone(), session_clone);
                if let Err(e) = flush_sessions_to_db(&conn, &sessions, now_ms()) {
                    eprintln!("Failed to save final session stats to DB: {}", e);
                }
            }
        });
    }
}

/// 查询指定时间范围内的流量历史记录数量
pub fn count_traffic_history(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    user_id: Option<&str>,
) -> Result<u32, rusqlite::Error> {
    let (where_clause, params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(uid) = user_id {
        (
            "WHERE recorded_at >= ?1 AND recorded_at <= ?2 AND user_id = ?3",
            vec![
                Box::new(from_ms),
                Box::new(to_ms),
                Box::new(uid.to_string()),
            ],
        )
    } else {
        (
            "WHERE recorded_at >= ?1 AND recorded_at <= ?2",
            vec![Box::new(from_ms), Box::new(to_ms)],
        )
    };

    let sql = format!(
        "SELECT COUNT(*) FROM traffic_snapshots {}",
        where_clause
    );
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let count: i64 = conn.query_row(&sql, param_refs.as_slice(), |row| row.get(0))?;
    Ok(count.max(0) as u32)
}

/// 分页查询历史流量快照
/// 返回 (rows, total) 其中 total 是符合条件（时间范围 + 用户）的总记录数
pub fn query_traffic_history_paginated(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    user_id: Option<&str>,
    page: u32,
    page_size: u32,
) -> Result<(Vec<serde_json::Value>, u32), rusqlite::Error> {
    let total = count_traffic_history(conn, from_ms, to_ms, user_id)?;
    let page = page.max(1) as i64;
    let page_size = page_size.max(1).min(500) as i64;
    let offset = (page - 1) * page_size;
    if offset >= total as i64 {
        return Ok((Vec::new(), total));
    }

    let (where_clause, mut params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(uid) = user_id {
        (
            "WHERE recorded_at >= ?1 AND recorded_at <= ?2 AND user_id = ?3",
            vec![
                Box::new(from_ms),
                Box::new(to_ms),
                Box::new(uid.to_string()),
            ],
        )
    } else {
        (
            "WHERE recorded_at >= ?1 AND recorded_at <= ?2",
            vec![Box::new(from_ms), Box::new(to_ms)],
        )
    };

    let sql = format!(
        "SELECT recorded_at, user_id, session_id, username,
                inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes
         FROM traffic_snapshots
         {}
         ORDER BY recorded_at DESC, id DESC
         LIMIT ?{} OFFSET ?{}",
        where_clause,
        params.len() + 1,
        params.len() + 2,
    );
    params.push(Box::new(page_size));
    params.push(Box::new(offset));

    let mut stmt = conn.prepare(&sql)?;
    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let rows = stmt.query_map(param_refs.as_slice(), |row| {
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
    })?;

    let mut results = Vec::new();
    for row in rows {
        results.push(row?);
    }
    Ok((results, total))
}

/// Query aggregated traffic totals for a user within a time range
pub fn query_traffic_history_totals(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    user_id: Option<&str>,
) -> Result<(u64, u64, u64, u64), rusqlite::Error> {
    let (where_clause, params): (&str, Vec<Box<dyn rusqlite::types::ToSql>>) = if let Some(uid) = user_id {
        (
            "WHERE recorded_at >= ?1 AND recorded_at <= ?2 AND user_id = ?3",
            vec![
                Box::new(from_ms),
                Box::new(to_ms),
                Box::new(uid.to_string()),
            ],
        )
    } else {
        (
            "WHERE recorded_at >= ?1 AND recorded_at <= ?2",
            vec![Box::new(from_ms), Box::new(to_ms)],
        )
    };

    let sql = format!(
        "SELECT COALESCE(SUM(inbound_bytes), 0), COALESCE(SUM(outbound_bytes), 0),
                COALESCE(SUM(relay_forwarded_bytes), 0), COALESCE(SUM(handshake_bytes), 0)
         FROM traffic_snapshots {}",
        where_clause,
    );

    let param_refs: Vec<&dyn rusqlite::types::ToSql> = params.iter().map(|p| p.as_ref()).collect();
    let result = conn.query_row(&sql, param_refs.as_slice(), |row| {
        Ok((
            row.get::<_, i64>(0)? as u64,
            row.get::<_, i64>(1)? as u64,
            row.get::<_, i64>(2)? as u64,
            row.get::<_, i64>(3)? as u64,
        ))
    })?;

    Ok(result)
}

// ===== User Relay Quota =====

/// Per-user relay quota and lifetime usage.
#[derive(Debug, Clone, Serialize)]
pub struct UserRelayQuota {
    pub user_id: String,
    pub quota_bytes: u64,
    pub used_bytes: u64,
    pub updated_at: u64,
}

/// Initialize the user relay quota table.
pub fn init_user_quota_table(conn: &Connection) -> Result<(), rusqlite::Error> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS user_relay_quotas (
            user_id TEXT PRIMARY KEY,
            quota_bytes INTEGER NOT NULL DEFAULT 0,
            used_bytes INTEGER NOT NULL DEFAULT 0,
            updated_at INTEGER NOT NULL DEFAULT 0
        );",
        [],
    )?;
    Ok(())
}

/// Load all user relay quotas from DB.
pub fn load_user_relay_quotas(conn: &Connection) -> Result<HashMap<String, UserRelayQuota>, rusqlite::Error> {
    let mut stmt = conn.prepare(
        "SELECT user_id, quota_bytes, used_bytes, updated_at FROM user_relay_quotas"
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(UserRelayQuota {
            user_id: row.get(0)?,
            quota_bytes: row.get::<_, i64>(1)? as u64,
            used_bytes: row.get::<_, i64>(2)? as u64,
            updated_at: row.get::<_, i64>(3)? as u64,
        })
    })?;

    let mut result = HashMap::new();
    for row in rows {
        let quota = row?;
        result.insert(quota.user_id.clone(), quota);
    }
    Ok(result)
}

/// Save (upsert) all user relay quotas to DB.
pub fn save_user_relay_quotas(
    conn: &Connection,
    quotas: &HashMap<String, UserRelayQuota>,
) -> Result<(), rusqlite::Error> {
    if quotas.is_empty() {
        return Ok(());
    }
    let tx = conn.unchecked_transaction()?;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO user_relay_quotas (user_id, quota_bytes, used_bytes, updated_at)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(user_id) DO UPDATE SET
                quota_bytes = excluded.quota_bytes,
                used_bytes = excluded.used_bytes,
                updated_at = excluded.updated_at"
        )?;
        for q in quotas.values() {
            stmt.execute(rusqlite::params![
                q.user_id,
                q.quota_bytes as i64,
                q.used_bytes as i64,
                q.updated_at as i64,
            ])?;
        }
    }
    tx.commit()?;
    Ok(())
}

/// Save a single user relay quota to DB.
pub fn save_user_relay_quota(
    conn: &Connection,
    quota: &UserRelayQuota,
) -> Result<(), rusqlite::Error> {
    let mut quotas = HashMap::new();
    quotas.insert(quota.user_id.clone(), quota.clone());
    save_user_relay_quotas(conn, &quotas)
}

/// Save final quota snapshot for a closing session's user.
pub fn save_final_user_quota(
    db_path: &Option<String>,
    quota: &UserRelayQuota,
) {
    if let Some(path) = db_path {
        let quota_clone = quota.clone();
        let path_clone = path.clone();
        tokio::spawn(async move {
            if let Ok(conn) = Connection::open(path_clone) {
                if let Err(e) = save_user_relay_quota(&conn, &quota_clone) {
                    eprintln!("Failed to save final user quota to DB: {}", e);
                }
            }
        });
    }
}

/// 启动流量统计持久化后台任务
pub fn start_persistence_task(
    state: Arc<crate::handler::AppState>,
    db_path: String,
    flush_interval_secs: u64,
) {
    tokio::spawn(async move {
        let conn = match init_db(&db_path) {
            Ok(c) => {
                println!("Traffic stats persistence initialized: {}", db_path);
                c
            }
            Err(e) => {
                eprintln!("Failed to init traffic DB: {}", e);
                return;
            }
        };

        // 1. 加载初始全局统计数据
        match load_global_traffic(&conn) {
            Ok(global) => {
                let mut tr = state.traffic.lock().unwrap();
                tr.set_global(global);
                println!("Loaded historical global traffic data");
            }
            Err(e) => {
                eprintln!("Failed to load global traffic data: {}", e);
            }
        }

        // 2. 初始化并加载用户转发额度
        if let Err(e) = init_user_quota_table(&conn) {
            eprintln!("Failed to init user quota table: {}", e);
        } else {
            match load_user_relay_quotas(&conn) {
                Ok(quotas) => {
                    for (user_id, quota) in quotas {
                        state.user_quotas.insert(user_id, quota);
                    }
                    println!("Loaded {} user relay quota record(s)", state.user_quotas.len());
                }
                Err(e) => {
                    eprintln!("Failed to load user relay quotas: {}", e);
                }
            }
        }

        // 3. 循环执行持久化任务
        let mut sys = System::new_all();
        // 初始刷新，为后续 CPU 计算建立基准
        sys.refresh_cpu_all();
        sys.refresh_memory();
        
        println!("Traffic stats flush task started (interval: {}s)", flush_interval_secs);
        
        loop {
            sleep(Duration::from_secs(flush_interval_secs)).await;
            let recorded_at = now_ms();
            
            // A. 获取会话快照和全局流量
            let (sessions, global) = {
                let tr = state.traffic.lock().unwrap();
                (tr.sessions.clone(), tr.global.clone())
            };

            // B. 保存会话快照
            if !sessions.is_empty() {
                if let Err(e) = flush_sessions_to_db(&conn, &sessions, recorded_at) {
                    eprintln!("Failed to flush session traffic snapshots: {}", e);
                }
            }

            // C. 保存全局流量
            if let Err(e) = save_global_traffic(&conn, &global) {
                eprintln!("Failed to save global traffic stats: {}", e);
            }

            // D. 保存用户转发额度快照
            let quotas = {
                let mut map = HashMap::new();
                for q in state.user_quotas.iter() {
                    map.insert(q.key().clone(), q.value().clone());
                }
                map
            };
            if !quotas.is_empty() {
                if let Err(e) = save_user_relay_quotas(&conn, &quotas) {
                    eprintln!("Failed to flush user relay quotas: {}", e);
                }
            }

            // E. 采集系统指标（CPU + 内存使用率）
            // 每次循环刷新一次，sysinfo 会计算自上次刷新以来的 CPU 平均负载
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

            if let Err(e) = save_system_stats(&conn, recorded_at, cpu_avg, mem_percent) {
                eprintln!("Failed to save system stats: {}", e);
            }
        }
    });
}
