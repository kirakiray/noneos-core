/// 管理命令处理
/// sysinfo 调用在 spawn_blocking 中执行，不阻塞 async runtime

use std::sync::Arc;
use crate::state::AppState;
use crate::protocol::{AdminCommand, AdminResponse, now_ms};
use crate::db;

pub async fn handle_admin_command(
    state: &Arc<AppState>,
    cmd: AdminCommand,
    _admin_user_id: &str,
    _admin_session_id: &str,
) -> AdminResponse {
    match cmd.action.as_str() {
        "list_users" => handle_list_users(state, cmd).await,
        "list_user_groups" => handle_list_user_groups(state, cmd).await,
        "list_all_users" => handle_list_all_users(state, cmd).await,
        "disconnect_user" => handle_disconnect_user(state, &cmd),
        "disconnect_session" => handle_disconnect_session(state, &cmd),
        "get_system_info" => handle_system_info().await,
        "get_traffic_stats" => handle_traffic_stats(state, cmd.limit).await,
        "get_online_users" => handle_online_users(state, cmd).await,
        "get_all_users" => handle_all_users_db(state, cmd).await,
        "get_traffic_history" => handle_traffic_history(state, cmd).await,
        "get_system_stats_history" => handle_system_stats_history(state, cmd).await,
        "get_user_relay_quota" => handle_get_user_quota(state, &cmd),
        "set_user_relay_quota" => handle_set_user_quota(state, &cmd),
        _ => {
            let action = cmd.action.clone();
            let mut resp = AdminResponse::default();
            resp.msg_type = "admin_response".to_string();
            resp.action = cmd.action;
            resp.status = "error".to_string();
            resp.message = Some(format!("Unknown action: {}", action));
            resp
        }
    }
}

async fn handle_list_users(state: &AppState, cmd: AdminCommand) -> AdminResponse {
    let (users, total) = state.get_users_paginated(cmd.page, cmd.page_size);
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "list_users".to_string();
    resp.status = "ok".to_string();
    resp.users = Some(users);
    resp.total = Some(total);
    resp.page = Some(cmd.page);
    resp.page_size = Some(cmd.page_size);
    resp
}

fn handle_disconnect_user(state: &AppState, cmd: &AdminCommand) -> AdminResponse {
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "disconnect_user".to_string();

    if let Some(ref user_ids) = cmd.user_ids {
        let mut total = 0;
        for uid in user_ids {
            if let Some(ref session_id) = cmd.session_id {
                if state.disconnect_session(uid, session_id) {
                    total += 1;
                }
            } else {
                total += state.disconnect_user_by_id(uid);
            }
        }
        resp.status = "ok".to_string();
        resp.message = Some(format!("Disconnected {} sessions", total));
    } else if let Some(ref uid) = cmd.user_id {
        let count = if let Some(ref session_id) = cmd.session_id {
            if state.disconnect_session(uid, session_id) { 1 } else { 0 }
        } else {
            state.disconnect_user_by_id(uid)
        };
        resp.status = if count > 0 { "ok".to_string() } else { "error".to_string() };
        resp.message = Some(format!("Disconnected {} sessions", count));
    } else {
        resp.status = "error".to_string();
        resp.message = Some("Missing user_id or user_ids".to_string());
    }
    resp
}

async fn handle_system_info() -> AdminResponse {
    let info = tokio::task::spawn_blocking(move || {
        let sys = sysinfo::System::new_all();

        let mem_used = sys.used_memory();
        let mem_total = sys.total_memory();
        let mem_available = sys.available_memory();
        let mem_percent = if mem_total > 0 {
            ((mem_used as f64 / mem_total as f64) * 100.0 * 100.0).round() / 100.0
        } else {
            0.0
        };

        let cores: Vec<serde_json::Value> = sys.cpus().iter().enumerate().map(|(i, cpu_info)| {
            serde_json::json!({
                "index": i,
                "usage_percent": cpu_info.cpu_usage(),
            })
        }).collect();

        let disks = sysinfo::Disks::new_with_refreshed_list();
        let disk_list: Vec<serde_json::Value> = disks.iter().map(|disk| {
            serde_json::json!({
                "mount_point": disk.mount_point().to_string_lossy(),
                "total_space": disk.total_space(),
                "available_space": disk.available_space(),
                "file_system": disk.file_system().to_string_lossy(),
            })
        }).collect();

        serde_json::json!({
            "memory": {
                "total": mem_total,
                "used": mem_used,
                "available": mem_available,
                "usage_percent": mem_percent,
            },
            "cpu": {
                "core_count": sys.cpus().len(),
                "cores": cores,
            },
            "disks": disk_list,
        })
    }).await.unwrap_or_else(|_| serde_json::json!({"error": "Failed to get system info"}));

    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "get_system_info".to_string();
    resp.status = "ok".to_string();
    resp.system_info = Some(info);
    resp
}

/// 获取内存使用百分比（用于过载保护）
pub async fn get_memory_usage_percent() -> f64 {
    tokio::task::spawn_blocking(|| {
        let sys = sysinfo::System::new_all();
        let used = sys.used_memory();
        let total = sys.total_memory();
        if total > 0 { (used as f64 / total as f64) * 100.0 } else { 0.0 }
    }).await.unwrap_or(0.0)
}

/// 获取 CPU 和内存使用率（用于定时持久化）
pub async fn get_cpu_mem_usage() -> (f64, f64) {
    tokio::task::spawn_blocking(|| {
        let sys = sysinfo::System::new_all();
        let cpu = sys.global_cpu_usage() as f64 * 100.0;
        let used = sys.used_memory();
        let total = sys.total_memory();
        let mem = if total > 0 { (used as f64 / total as f64) * 100.0 } else { 0.0 };
        (cpu, mem)
    }).await.unwrap_or((0.0, 0.0))
}

async fn handle_traffic_stats(state: &AppState, limit: Option<usize>) -> AdminResponse {
    let response = {
        let tr = state.traffic.read().await;
        tr.build_response(limit)
    };

    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "get_traffic_stats".to_string();
    resp.status = "ok".to_string();
    resp.traffic = Some(serde_json::to_value(&response).unwrap_or_default());
    resp
}

async fn handle_online_users(state: &AppState, cmd: AdminCommand) -> AdminResponse {
    let (users, total) = state.get_users_paginated(cmd.page, cmd.page_size.clamp(1, 100));
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "get_online_users".to_string();
    resp.status = "ok".to_string();
    resp.users = Some(users);
    resp.total = Some(total);
    resp.page = Some(cmd.page);
    resp.page_size = Some(cmd.page_size);
    resp
}

async fn handle_all_users_db(state: &AppState, cmd: AdminCommand) -> AdminResponse {
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "get_all_users".to_string();

    if let Some(ref db_tx) = state.db {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let _ = db_tx.send(db::DbCmd::QueryUsersPaginated {
            page: cmd.page, page_size: cmd.page_size.clamp(1, 500), reply: reply_tx,
        });
        match reply_rx.await {
            Ok(Ok((users, total))) => {
                resp.status = "ok".to_string();
                resp.users = Some(users);
                resp.total = Some(total);
                resp.page = Some(cmd.page);
                resp.page_size = Some(cmd.page_size);
            }
            Ok(Err(e)) => {
                resp.status = "error".to_string();
                resp.message = Some(e);
            }
            Err(_) => {
                resp.status = "error".to_string();
                resp.message = Some("DB actor communication failure".to_string());
            }
        }
    } else {
        resp.status = "error".to_string();
        resp.message = Some("DB not configured".to_string());
    }
    resp
}

async fn handle_traffic_history(state: &AppState, cmd: AdminCommand) -> AdminResponse {
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "get_traffic_history".to_string();

    if let Some(ref db_tx) = state.db {
        let now = now_ms() as i64;
        let from_ms = cmd.from_ms.unwrap_or(now - 3600_000); // 默认最近 1 小时

        // 并行查询历史和总计
        let (hist_tx, hist_rx) = tokio::sync::oneshot::channel();
        let _ = db_tx.send(db::DbCmd::QueryTrafficHistoryPaginated {
            from_ms, to_ms: now, user_id: cmd.user_id.clone(),
            page: cmd.page, page_size: cmd.page_size.clamp(1, 500), reply: hist_tx,
        });
        let (totals_tx, totals_rx) = tokio::sync::oneshot::channel();
        let _ = db_tx.send(db::DbCmd::QueryTrafficHistoryTotals {
            from_ms, to_ms: now, user_id: cmd.user_id.clone(), reply: totals_tx,
        });

        match hist_rx.await {
            Ok(Ok((history, total))) => {
                resp.status = "ok".to_string();
                resp.history = Some(history);
                resp.total = Some(total);
                resp.page = Some(cmd.page);
                resp.page_size = Some(cmd.page_size);
            }
            Ok(Err(e)) => {
                resp.status = "error".to_string();
                resp.message = Some(e);
            }
            Err(_) => {
                resp.status = "error".to_string();
                resp.message = Some("DB communication failure".to_string());
            }
        }

        // 附加总计
        if let Ok(Ok((inb, outb, relay, hand))) = totals_rx.await {
            resp.total_inbound_bytes = Some(inb);
            resp.total_outbound_bytes = Some(outb);
            resp.total_relay_forwarded_bytes = Some(relay);
            resp.total_handshake_bytes = Some(hand);
        }
    } else {
        resp.status = "error".to_string();
        resp.message = Some("DB not configured".to_string());
    }
    resp
}

async fn handle_system_stats_history(state: &AppState, cmd: AdminCommand) -> AdminResponse {
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "get_system_stats_history".to_string();

    if let Some(ref db_tx) = state.db {
        let limit = cmd.limit.unwrap_or(60);
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let _ = db_tx.send(db::DbCmd::QuerySystemStatsHistory { limit, reply: reply_tx });

        match reply_rx.await {
            Ok(Ok(records)) => {
                let stats: Vec<serde_json::Value> = records.into_iter().map(|(t, cpu, mem)| {
                    serde_json::json!({"recordedAt": t, "cpuUsagePercent": cpu, "memoryUsagePercent": mem})
                }).collect();
                resp.status = "ok".to_string();
                resp.system_stats = Some(stats);
            }
            Ok(Err(e)) => {
                resp.status = "error".to_string();
                resp.message = Some(e);
            }
            Err(_) => {
                resp.status = "error".to_string();
                resp.message = Some("DB communication failure".to_string());
            }
        }
    } else {
        resp.status = "error".to_string();
        resp.message = Some("DB not configured".to_string());
    }
    resp
}

fn handle_get_user_quota(state: &AppState, cmd: &AdminCommand) -> AdminResponse {
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "get_user_relay_quota".to_string();

    // 优先处理批量查询（user_ids 数组）
    if let Some(ref user_ids) = cmd.user_ids {
        let quotas: Vec<serde_json::Value> = user_ids.iter().map(|uid| {
            let quota = state.get_or_create_user_quota(uid);
            serde_json::to_value(&quota).unwrap_or_default()
        }).collect();
        resp.status = "ok".to_string();
        resp.quotas = Some(quotas);
    } else if let Some(ref uid) = cmd.user_id {
        let quota = state.get_or_create_user_quota(uid);
        resp.status = "ok".to_string();
        resp.quota = Some(serde_json::to_value(&quota).unwrap_or_default());
    } else {
        // 没有传 user_id 或 user_ids，返回所有用户的额度
        let quotas: Vec<serde_json::Value> = state.user_quotas.iter()
            .map(|r| serde_json::to_value(r.value()).unwrap_or_default())
            .collect();
        resp.status = "ok".to_string();
        resp.quotas = Some(quotas);
    }
    resp
}

fn handle_set_user_quota(state: &AppState, cmd: &AdminCommand) -> AdminResponse {
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "set_user_relay_quota".to_string();

    if let (Some(ref uid), Some(quota_bytes)) = (&cmd.user_id, cmd.quota_bytes) {
        let quota = state.set_user_relay_quota(uid, quota_bytes);
        resp.status = "ok".to_string();
        resp.quota = Some(serde_json::to_value(&quota).unwrap_or_default());
    } else {
        resp.status = "error".to_string();
        resp.message = Some("Missing user_id or quota_bytes".to_string());
    }
    resp
}

// ── list_all_users: 从 DB 查询所有用户（含离线），并标记在线状态 ──

async fn handle_list_all_users(state: &AppState, cmd: AdminCommand) -> AdminResponse {
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "list_all_users".to_string();

    if let Some(ref db_tx) = state.db {
        let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
        let _ = db_tx.send(db::DbCmd::QueryUsersPaginated {
            page: cmd.page,
            page_size: cmd.page_size.clamp(1, 500),
            reply: reply_tx,
        });

        match reply_rx.await {
            Ok(Ok((mut users, total))) => {
                // 给每个用户附加 isOnline 标记
                for user in users.iter_mut() {
                    if let Some(user_id_val) = user.get("userId").and_then(|v| v.as_str()) {
                        let prefix = format!("{}:", user_id_val);
                        let is_online = state.users.iter().any(|r| r.key().starts_with(&prefix));
                        if let Some(obj) = user.as_object_mut() {
                            obj.insert("isOnline".to_string(), serde_json::Value::Bool(is_online));
                        }
                    }
                }

                resp.status = "ok".to_string();
                resp.message = Some(format!("Found {} total user(s) in database", total));
                resp.users = Some(users);
                resp.total = Some(total);
                resp.page = Some(cmd.page);
                resp.page_size = Some(cmd.page_size);
            }
            Ok(Err(e)) => {
                resp.status = "error".to_string();
                resp.message = Some(format!("Database query error: {}", e));
            }
            Err(_) => {
                resp.status = "error".to_string();
                resp.message = Some("DB actor communication failure".to_string());
            }
        }
    } else {
        resp.status = "error".to_string();
        resp.message = Some("Traffic database is not configured".to_string());
    }
    resp
}

// ── disconnect_session: 断开指定用户的指定 session ──

fn handle_disconnect_session(state: &AppState, cmd: &AdminCommand) -> AdminResponse {
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "disconnect_session".to_string();

    let target_user = cmd.user_id.clone().unwrap_or_default();
    let target_session = cmd.session_id.clone().unwrap_or_default();

    if target_session.is_empty() {
        resp.status = "error".to_string();
        resp.message = Some("Missing session_id".to_string());
    } else if state.disconnect_session(&target_user, &target_session) {
        resp.status = "ok".to_string();
        resp.message = Some(format!("Session {} disconnected for user {}", target_session, target_user));
    } else {
        resp.status = "error".to_string();
        resp.message = Some(format!("Session {} not found for user {}", target_session, target_user));
    }
    resp
}

// ── list_user_groups: 按 userId 分组列出在线用户 ──

async fn handle_list_user_groups(state: &AppState, cmd: AdminCommand) -> AdminResponse {
    let mut resp = AdminResponse::default();
    resp.msg_type = "admin_response".to_string();
    resp.action = "list_user_groups".to_string();

    // 按 userId 分组
    use std::collections::BTreeMap;
    let mut user_map: BTreeMap<String, (String, String, Vec<serde_json::Value>)> = BTreeMap::new();

    for r in state.users.iter() {
        let conn_key = r.key();
        let session = r.value();
        let parts: Vec<&str> = conn_key.splitn(2, ':').collect();
        let user_id = parts[0].to_string();
        let session_id = if parts.len() == 2 { parts[1].to_string() } else { String::new() };

        let session_json = serde_json::json!({
            "sessionId": session_id,
            "host": session.host,
            "addr": session.addr.to_string(),
            "latencyMs": session.latency_ms,
            "connectedAt": session.connected_at,
        });

        let entry = user_map.entry(user_id.clone()).or_insert_with(|| {
            (user_id.clone(), session.username.clone(), Vec::new())
        });
        entry.2.push(session_json);
    }

    let all_groups: Vec<serde_json::Value> = user_map.into_values().map(|(uid, name, sessions)| {
        serde_json::json!({
            "userId": uid,
            "username": name,
            "sessionCount": sessions.len(),
            "sessions": sessions,
        })
    }).collect();

    let total = all_groups.len() as u32;
    let page = cmd.page.max(1) as usize;
    let page_size = cmd.page_size.clamp(1, 100) as usize;
    let start = (page - 1) * page_size;

    let paged = if start >= all_groups.len() {
        Vec::new()
    } else {
        let end = start + page_size.min(all_groups.len() - start);
        all_groups[start..end].to_vec()
    };

    resp.status = "ok".to_string();
    resp.message = Some(format!("{} user group(s) connected", paged.len()));
    resp.users = Some(paged);
    resp.total = Some(total);
    resp.page = Some(cmd.page);
    resp.page_size = Some(cmd.page_size);
    resp
}
