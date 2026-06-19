use std::collections::HashMap;
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
}

/// Traffic statistics container — lives inside AppState
pub struct TrafficStats {
    pub sessions: HashMap<String, SessionTraffic>,
    pub minute_buckets: Vec<MinuteBucket>,
    current_minute_epoch: u64,
    minute_window: usize,
}

impl TrafficStats {
    pub fn new(minute_window: usize) -> Self {
        Self {
            sessions: HashMap::new(),
            minute_buckets: Vec::with_capacity(minute_window),
            current_minute_epoch: 0,
            minute_window,
        }
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
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.inbound_bytes = s.inbound_bytes.saturating_add(bytes);
            s.last_activity_at = now_ms;
        }
    }

    /// Count outbound bytes (server → client)
    pub fn add_outbound(&mut self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, 0, bytes, 0);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.outbound_bytes = s.outbound_bytes.saturating_add(bytes);
            s.last_activity_at = now_ms;
        }
    }

    /// Count relay-forwarded bytes (this session relayed data TO another session)
    pub fn add_relay_forwarded(&mut self, conn_key: &str, bytes: u64, now_ms: u64) {
        self.update_minute_bucket(now_ms, 0, 0, bytes);
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.relay_forwarded_bytes = s.relay_forwarded_bytes.saturating_add(bytes);
            s.last_activity_at = now_ms;
        }
    }

    /// Count handshake bytes
    pub fn add_handshake(&mut self, conn_key: &str, bytes: u64, _now_ms: u64) {
        if let Some(s) = self.sessions.get_mut(conn_key) {
            s.handshake_bytes = s.handshake_bytes.saturating_add(bytes);
        }
    }

    /// Update the minute-level sliding window
    fn update_minute_bucket(&mut self, now_ms: u64, inbound: u64, outbound: u64, relay: u64) {
        let minute_epoch = now_ms / 60_000;
        if minute_epoch != self.current_minute_epoch {
            // Fill gap minutes if we skipped multiple minutes
            if let Some(last) = self.minute_buckets.last() {
                for m in (last.minute_epoch + 1)..minute_epoch {
                    if self.minute_buckets.len() >= self.minute_window {
                        self.minute_buckets.remove(0);
                    }
                    self.minute_buckets.push(MinuteBucket {
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
        if let Some(bucket) = self
            .minute_buckets
            .iter_mut()
            .find(|b| b.minute_epoch == minute_epoch)
        {
            bucket.inbound_bytes = bucket.inbound_bytes.saturating_add(inbound);
            bucket.outbound_bytes = bucket.outbound_bytes.saturating_add(outbound);
            bucket.relay_forwarded_bytes = bucket.relay_forwarded_bytes.saturating_add(relay);
        } else {
            if self.minute_buckets.len() >= self.minute_window {
                self.minute_buckets.remove(0);
            }
            self.minute_buckets.push(MinuteBucket {
                minute_epoch,
                inbound_bytes: inbound,
                outbound_bytes: outbound,
                relay_forwarded_bytes: relay,
            });
        }
    }

    /// Compute global totals from all active sessions
    pub fn compute_global(&self) -> GlobalTraffic {
        let mut global = GlobalTraffic::default();
        for s in self.sessions.values() {
            global.inbound_bytes =
                global.inbound_bytes.saturating_add(s.inbound_bytes);
            global.outbound_bytes =
                global.outbound_bytes.saturating_add(s.outbound_bytes);
            global.relay_forwarded_bytes =
                global.relay_forwarded_bytes.saturating_add(s.relay_forwarded_bytes);
            global.handshake_bytes =
                global.handshake_bytes.saturating_add(s.handshake_bytes);
        }
        global
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
        self.minute_buckets.clone()
    }

    /// Get traffic data for a specific user's sessions
    pub fn get_user_sessions(&self, user_id: &str) -> Vec<SessionTraffic> {
        self.sessions
            .values()
            .filter(|s| s.user_id == user_id)
            .cloned()
            .collect()
    }

    /// Build the full response for the admin command
    pub fn build_response(&self) -> TrafficStatsResponse {
        TrafficStatsResponse {
            global: self.compute_global(),
            users: self.compute_user_summaries(),
            time_distribution: self.get_time_distribution(),
        }
    }

    /// Get a count of active sessions being tracked
    pub fn session_count(&self) -> usize {
        self.sessions.len()
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
        CREATE INDEX IF NOT EXISTS idx_ts_user ON traffic_snapshots(user_id);",
    )?;
    Ok(conn)
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
