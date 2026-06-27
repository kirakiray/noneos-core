use tokio::sync::{mpsc, oneshot};
use rusqlite::Connection;
use std::collections::HashMap;
use crate::traffic::{self, SessionTraffic, UserRecord, UserRelayQuota, GlobalTraffic, SystemStatsRecord};
use serde_json::Value;

#[derive(Debug)]
pub enum DbCommand {
    SaveUser(UserRecord),
    SaveFinalSession(SessionTraffic),
    SaveFinalUserQuota(UserRelayQuota),
    SetUserRelayQuota(UserRelayQuota),
    FlushTraffic {
        sessions: HashMap<String, SessionTraffic>,
        global: GlobalTraffic,
        quotas: HashMap<String, UserRelayQuota>,
        recorded_at: u64,
    },
    SaveSystemStats {
        recorded_at: u64,
        cpu_percent: f64,
        mem_percent: f64,
    },
    QueryAllUsers {
        page: u32,
        page_size: u32,
        reply: oneshot::Sender<Result<(Vec<Value>, u32), String>>,
    },
    QueryTrafficHistory {
        from_ms: i64,
        to_ms: i64,
        user_id: Option<String>,
        page: u32,
        page_size: u32,
        reply: oneshot::Sender<Result<(Vec<Value>, u32, u64, u64, u64, u64), String>>,
    },
    QuerySystemStatsHistory {
        limit: usize,
        reply: oneshot::Sender<Result<Vec<SystemStatsRecord>, String>>,
    },
}

pub struct DbActor {
    conn: Connection,
    receiver: mpsc::Receiver<DbCommand>,
}

impl DbActor {
    pub fn new(db_path: &str, receiver: mpsc::Receiver<DbCommand>) -> Result<(Self, GlobalTraffic, HashMap<String, UserRelayQuota>), rusqlite::Error> {
        let conn = traffic::init_db(db_path)?;
        // Enable WAL mode for better concurrency and performance
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        traffic::init_user_quota_table(&conn)?;
        
        let global = traffic::load_global_traffic(&conn)?;
        let quotas = traffic::load_user_relay_quotas(&conn)?;
        
        Ok((Self { conn, receiver }, global, quotas))
    }

    pub fn run(mut self) {
        while let Some(cmd) = self.receiver.blocking_recv() {
            self.handle_command(cmd);
        }
    }

    fn handle_command(&mut self, cmd: DbCommand) {
        match cmd {
            DbCommand::SaveUser(user) => {
                let _ = traffic::save_user(&self.conn, &user);
            }
            DbCommand::SaveFinalSession(session) => {
                let mut map = HashMap::new();
                map.insert(session.conn_key.clone(), session);
                let _ = traffic::flush_sessions_to_db(&self.conn, &map, traffic::now_ms());
            }
            DbCommand::SaveFinalUserQuota(quota) | DbCommand::SetUserRelayQuota(quota) => {
                let _ = traffic::save_user_relay_quota(&self.conn, &quota);
            }
            DbCommand::FlushTraffic { sessions, global, quotas, recorded_at } => {
                if !sessions.is_empty() {
                    let _ = traffic::flush_sessions_to_db(&self.conn, &sessions, recorded_at);
                }
                let _ = traffic::save_global_traffic(&self.conn, &global);
                if !quotas.is_empty() {
                    let _ = traffic::save_user_relay_quotas(&self.conn, &quotas);
                }
            }
            DbCommand::SaveSystemStats { recorded_at, cpu_percent, mem_percent } => {
                let _ = traffic::save_system_stats(&self.conn, recorded_at, cpu_percent, mem_percent);
            }
            DbCommand::QueryAllUsers { page, page_size, reply } => {
                let res = traffic::query_users_paginated(&self.conn, page, page_size)
                    .map_err(|e| e.to_string());
                let _ = reply.send(res);
            }
            DbCommand::QueryTrafficHistory { from_ms, to_ms, user_id, page, page_size, reply } => {
                let res = (|| {
                    let (history, total) = traffic::query_traffic_history_paginated(&self.conn, from_ms, to_ms, user_id.as_deref(), page, page_size)?;
                    let (t_in, t_out, t_rel, t_hand) = traffic::query_traffic_history_totals(&self.conn, from_ms, to_ms, user_id.as_deref())?;
                    Ok((history, total, t_in, t_out, t_rel, t_hand))
                })().map_err(|e: rusqlite::Error| e.to_string());
                let _ = reply.send(res);
            }
            DbCommand::QuerySystemStatsHistory { limit, reply } => {
                let res = traffic::query_system_stats_history(&self.conn, limit)
                    .map_err(|e| e.to_string());
                let _ = reply.send(res);
            }
        }
    }
}
