use std::collections::{HashMap, VecDeque};
use serde::Serialize;
use rusqlite::Connection;

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
        CREATE INDEX IF NOT EXISTS idx_ss_recorded ON system_stats(recorded_at);",
    )?;
    Ok(conn)
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

/// Query historical traffic snapshots from SQLite (all users or specific user)
pub fn query_traffic_history(
    conn: &Connection,
    from_ms: i64,
    to_ms: i64,
    user_id: Option<&str>,
) -> Result<Vec<serde_json::Value>, rusqlite::Error> {
    let (sql, params): (
        &str,
        Vec<Box<dyn rusqlite::types::ToSql>>,
    ) = if let Some(uid) = user_id {
        (
            "SELECT recorded_at, user_id, session_id, username,
                    inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes
             FROM traffic_snapshots
             WHERE recorded_at >= ?1 AND recorded_at <= ?2 AND user_id = ?3
             ORDER BY recorded_at ASC",
            vec![
                Box::new(from_ms),
                Box::new(to_ms),
                Box::new(uid.to_string()),
            ],
        )
    } else {
        (
            "SELECT recorded_at, user_id, session_id, username,
                    inbound_bytes, outbound_bytes, relay_forwarded_bytes, handshake_bytes
             FROM traffic_snapshots
             WHERE recorded_at >= ?1 AND recorded_at <= ?2
             ORDER BY recorded_at ASC",
            vec![Box::new(from_ms), Box::new(to_ms)],
        )
    };

    let mut stmt = conn.prepare(sql)?;
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
    Ok(results)
}
