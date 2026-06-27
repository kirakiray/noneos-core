use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use std::time::Duration;
use sysinfo::{System, Disks};
use crate::handler::{AppState};
use crate::traffic;

/// 管理命令请求格式
#[derive(Deserialize)]
pub struct AdminCommand {
    pub action: String,
    #[serde(default)]
    pub user_id: Option<String>,
    #[serde(default)]
    pub user_ids: Option<Vec<String>>,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default = "default_page")]
    pub page: u32,
    #[serde(default = "default_page_size")]
    pub page_size: u32,
    #[serde(default)]
    pub limit: Option<usize>,
    /// 可选：流量历史查询的起始时间戳（毫秒）。不传则默认查最近 1 小时。
    #[serde(default)]
    pub from_ms: Option<i64>,
    /// 可选：设置用户转发额度（字节）
    #[serde(default)]
    pub quota_bytes: Option<u64>,
}

pub fn default_page() -> u32 { 1 }
pub fn default_page_size() -> u32 { 20 }

/// 管理命令响应格式
#[derive(Default, Serialize)]
pub struct AdminResponse {
    #[serde(rename = "type")]
    pub msg_type: String,
    pub action: String,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub users: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_info: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub page_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub traffic: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub history: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_inbound_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_outbound_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_relay_forwarded_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_handshake_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_stats: Option<Vec<serde_json::Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quota: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub quotas: Option<Vec<serde_json::Value>>,
}

impl AppState {
    /// 设置用户转发额度（admin 用），并立即持久化到 DB（如果配置了 DB）
    pub fn set_user_relay_quota(&self, user_id: &str, quota_bytes: u64) -> traffic::UserRelayQuota {
        let now = traffic::now_ms();
        let mut quota = self.get_or_create_user_quota(user_id);
        quota.quota_bytes = quota_bytes;
        quota.updated_at = now;
        self.user_quotas.insert(user_id.to_string(), quota.clone());

        if let Some(ref db_tx) = self.db_tx {
            let _ = db_tx.try_send(crate::db_actor::DbCommand::SetUserRelayQuota(quota.clone()));
        }

        quota
    }

    /// 根据 userId 踢掉该用户的所有连接（用于管理员断开用户）
    pub fn disconnect_user_by_id(&self, target_user_id: &str) -> usize {
        let prefix = format!("{}:", target_user_id);
        let mut count = 0;
        
        // 使用 DashMap 的 retain 来安全地删除并处理
        self.users.retain(|key, session| {
            if key.starts_with(&prefix) {
                if let Some(tx) = session.disconnect_tx.take() {
                    let _ = tx.send(());
                }
                count += 1;
                false // 移除
            } else {
                true // 保留
            }
        });

        if count > 0 {
            self.user_session_counts.entry(target_user_id.to_string()).and_modify(|c| *c = c.saturating_sub(count));
        }
        
        count
    }

    /// 断开指定 session（conn_key = userId:sessionId）
    pub fn disconnect_session(&self, target_user_id: &str, target_session_id: &str) -> bool {
        let conn_key = format!("{}:{}", target_user_id, target_session_id);
        if let Some((_, mut session)) = self.users.remove(&conn_key) {
            if let Some(tx) = session.disconnect_tx.take() {
                let _ = tx.send(());
            }
            self.user_session_counts.entry(target_user_id.to_string()).and_modify(|c| *c = c.saturating_sub(1));
            true
        } else {
            false
        }
    }

    pub fn get_all_users(&self) -> Vec<serde_json::Value> {
        self.users.iter().map(|r| {
            let conn_key = r.key();
            let session = r.value();
            // 从 conn_key (userId:sessionId) 中拆分出 userId 和 sessionId
            let parts: Vec<&str> = conn_key.splitn(2, ':').collect();
            let (user_id, session_id) = if parts.len() == 2 {
                (parts[0].to_string(), parts[1].to_string())
            } else {
                (conn_key.clone(), String::new())
            };
            serde_json::json!({
                "userId": user_id,
                "sessionId": session_id,
                "username": session.username,
                "host": session.host,
                "addr": session.addr.to_string(),
                "latencyMs": session.latency_ms,
                "connectedAt": session.connected_at,
            })
        }).collect()
    }

    /// 分页获取用户列表
    /// 返回 (分页后的用户列表, 总用户数)
    pub fn get_users_paginated(&self, page: u32, page_size: u32) -> (Vec<serde_json::Value>, u32) {
        let all_users = self.get_all_users();
        let total = all_users.len() as u32;
        let page = page.max(1) as usize;
        let page_size = page_size.clamp(1, 100) as usize;
        let start = (page - 1) * page_size;
        if start >= all_users.len() {
            return (Vec::new(), total);
        }
        let end = start + page_size.min(all_users.len() - start);
        (all_users[start..end].to_vec(), total)
    }

    /// 按 userId 分组分页获取用户组
    /// 每个用户组包含 userId, username, sessionCount 和 sessions[] 列表
    /// 返回 (分页后的用户组列表, 总用户数（去重后）)
    pub fn get_user_groups_paginated(&self, page: u32, page_size: u32) -> (Vec<serde_json::Value>, u32) {
        // 按 userId 分组
        use std::collections::BTreeMap;
        let mut user_map: BTreeMap<String, (String, String, Vec<serde_json::Value>)> = BTreeMap::new();

        for r in self.users.iter() {
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

        let total = user_map.len() as u32;

        let all_groups: Vec<serde_json::Value> = user_map.into_iter().map(|(_key, (user_id, username, sessions))| {
            serde_json::json!({
                "userId": user_id,
                "username": username,
                "sessionCount": sessions.len(),
                "sessions": sessions,
            })
        }).collect();

        // 分页
        let page = page.max(1) as usize;
        let page_size = page_size.clamp(1, 100) as usize;
        let start = (page - 1) * page_size;
        if start >= all_groups.len() {
            return (Vec::new(), total);
        }
        let end = start + page_size.min(all_groups.len() - start);
        (all_groups[start..end].to_vec(), total)
    }
}

/// 获取当前内存使用率百分比（带 1 秒缓存，减少频繁调用开销）
pub async fn get_memory_usage_percent() -> f64 {
    static CACHE: OnceLock<std::sync::Mutex<(f64, std::time::Instant)>> = OnceLock::new();
    let cache_mutex = CACHE.get_or_init(|| {
        std::sync::Mutex::new((0.0, std::time::Instant::now() - Duration::from_secs(10)))
    });

    {
        let cache = cache_mutex.lock().unwrap();
        if cache.1.elapsed() < Duration::from_secs(1) {
            return cache.0;
        }
    }

    // 将阻塞的刷新操作移至 spawn_blocking
    let usage = tokio::task::spawn_blocking(|| {
        static SYSTEM: OnceLock<std::sync::Mutex<System>> = OnceLock::new();
        let mut system = SYSTEM.get_or_init(|| {
            std::sync::Mutex::new(System::new_with_specifics(sysinfo::RefreshKind::nothing().with_memory(sysinfo::MemoryRefreshKind::everything())))
        }).lock().unwrap();

        system.refresh_memory();
        let total = system.total_memory();
        if total == 0 {
            0.0
        } else {
            (system.used_memory() as f64 / total as f64 * 100.0 * 100.0).round() / 100.0
        }
    }).await.unwrap_or(0.0);

    let mut cache = cache_mutex.lock().unwrap();
    cache.0 = usage;
    cache.1 = std::time::Instant::now();
    usage
}

/// 收集系统信息（内存、CPU、磁盘使用情况，带 1 秒缓存）
pub async fn collect_system_info() -> serde_json::Value {
    static CACHE: OnceLock<std::sync::Mutex<(serde_json::Value, std::time::Instant)>> = OnceLock::new();
    let cache_mutex = CACHE.get_or_init(|| {
        std::sync::Mutex::new((serde_json::Value::Null, std::time::Instant::now() - Duration::from_secs(10)))
    });

    {
        let cache = cache_mutex.lock().unwrap();
        if cache.1.elapsed() < Duration::from_secs(1) {
            return cache.0.clone();
        }
    }

    let info = tokio::task::spawn_blocking(|| {
        static SYSTEM: OnceLock<std::sync::Mutex<System>> = OnceLock::new();
        let mut system = SYSTEM.get_or_init(|| {
            std::sync::Mutex::new(System::new_with_specifics(
                sysinfo::RefreshKind::nothing()
                    .with_memory(sysinfo::MemoryRefreshKind::everything())
                    .with_cpu(sysinfo::CpuRefreshKind::everything())
            ))
        }).lock().unwrap();

        // 刷新内存（快照型，一次即可）
        system.refresh_memory();
        // 刷新 CPU：至少需要两次刷新才能得到有意义的差值
        system.refresh_cpu_all();
        let disks = Disks::new_with_refreshed_list();

        // 内存信息（字节）
        let total_memory = system.total_memory();
        let used_memory = system.used_memory();
        let available_memory = system.available_memory();

        // CPU 信息：返回每个核心的单独占用率
        let cpu_count = system.cpus().len();
        let cores: Vec<serde_json::Value> = system.cpus().iter().enumerate().map(|(i, cpu)| {
            serde_json::json!({
                "index": i,
                "usage_percent": (cpu.cpu_usage() * 100.0).round() / 100.0,
            })
        }).collect();

        // 磁盘信息
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
                "total": total_memory,
                "used": used_memory,
                "available": available_memory,
                "usage_percent": if total_memory > 0 {
                    (used_memory as f64 / total_memory as f64 * 100.0 * 100.0).round() / 100.0
                } else {
                    0.0
                },
            },
            "cpu": {
                "core_count": cpu_count,
                "cores": cores,
            },
            "disks": disk_list,
        })
    }).await.unwrap_or(serde_json::Value::Null);

    let mut cache = cache_mutex.lock().unwrap();
    cache.0 = info.clone();
    cache.1 = std::time::Instant::now();
    info
}

pub async fn handle_admin_command(
    state: &AppState,
    admin_cmd: AdminCommand,
    user_id: &str,
    session_id: &str,
) -> AdminResponse {
    match admin_cmd.action.as_str() {
        "list_users" => {
            let (users, total) = state.get_users_paginated(admin_cmd.page, admin_cmd.page_size);
            let count = users.len();
            AdminResponse {
                msg_type: "admin_response".to_string(),
                action: "list_users".to_string(),
                status: "ok".to_string(),
                message: Some(format!("{} user(s) connected", count)),
                users: Some(users),
                system_info: None,
                total: Some(total),
                page: Some(admin_cmd.page),
                page_size: Some(admin_cmd.page_size),
                ..Default::default()
            }
        }
        "list_user_groups" => {
            let (users, total) = state.get_user_groups_paginated(admin_cmd.page, admin_cmd.page_size);
            let count = users.len();
            AdminResponse {
                msg_type: "admin_response".to_string(),
                action: "list_user_groups".to_string(),
                status: "ok".to_string(),
                message: Some(format!("{} user group(s) connected", count)),
                users: Some(users),
                system_info: None,
                total: Some(total),
                page: Some(admin_cmd.page),
                page_size: Some(admin_cmd.page_size),
                ..Default::default()
            }
        }
        "list_all_users" => {
            if let Some(ref db_tx) = state.db_tx {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let _ = db_tx.try_send(crate::db_actor::DbCommand::QueryAllUsers {
                    page: admin_cmd.page,
                    page_size: admin_cmd.page_size,
                    reply: tx,
                });
                match rx.await {
                    Ok(Ok((mut users, total))) => {
                        // 为查询结果添加在线状态标记
                        for user in users.iter_mut() {
                            if let Some(user_id_val) = user.get("userId").and_then(|v| v.as_str()) {
                                let prefix = format!("{}:", user_id_val);
                                let is_online = state.users.iter().any(|r| r.key().starts_with(&prefix));
                                if let Some(obj) = user.as_object_mut() {
                                    obj.insert("isOnline".to_string(), serde_json::Value::Bool(is_online));
                                }
                            }
                        }

                        AdminResponse {
                            msg_type: "admin_response".to_string(),
                            action: "list_all_users".to_string(),
                            status: "ok".to_string(),
                            message: Some(format!("Found {} total user(s) in database", total)),
                            users: Some(users),
                            total: Some(total),
                            page: Some(admin_cmd.page),
                            page_size: Some(admin_cmd.page_size),
                            ..Default::default()
                        }
                    }
                    Ok(Err(e)) => {
                        AdminResponse {
                            msg_type: "admin_response".to_string(),
                            action: "list_all_users".to_string(),
                            status: "error".to_string(),
                            message: Some(format!("Database query error: {}", e)),
                            ..Default::default()
                        }
                    }
                    Err(e) => {
                        AdminResponse {
                            msg_type: "admin_response".to_string(),
                            action: "list_all_users".to_string(),
                            status: "error".to_string(),
                            message: Some(format!("Spawn blocking error: {}", e)),
                            ..Default::default()
                        }
                    }
                }
            } else {
                AdminResponse {
                    msg_type: "admin_response".to_string(),
                    action: "list_all_users".to_string(),
                    status: "error".to_string(),
                    message: Some("Traffic database is not configured".to_string()),
                    ..Default::default()
                }
            }
        }
        "disconnect_user" => {
            let target_id = admin_cmd.user_id.clone().unwrap_or_default();
            if target_id == user_id {
                AdminResponse {
                    msg_type: "admin_response".to_string(),
                    action: "disconnect_user".to_string(),
                    status: "error".to_string(),
                    message: Some("Cannot disconnect yourself".to_string()),
                    ..Default::default()
                }
            } else {
                let count = state.disconnect_user_by_id(&target_id);
                if count > 0 {
                    println!("Admin {} disconnected user {} ({} session(s))", user_id, target_id, count);
                    AdminResponse {
                        msg_type: "admin_response".to_string(),
                        action: "disconnect_user".to_string(),
                        status: "ok".to_string(),
                        message: Some(format!("User {} disconnected ({} session(s))", target_id, count)),
                        ..Default::default()
                    }
                } else {
                    AdminResponse {
                        msg_type: "admin_response".to_string(),
                        action: "disconnect_user".to_string(),
                        status: "error".to_string(),
                        message: Some(format!("User {} not found", target_id)),
                        ..Default::default()
                    }
                }
            }
        }
        "disconnect_session" => {
            let target_user = admin_cmd.user_id.clone().unwrap_or_default();
            let target_session = admin_cmd.session_id.clone().unwrap_or_default();
            if target_session.is_empty() {
                AdminResponse {
                    msg_type: "admin_response".to_string(),
                    action: "disconnect_session".to_string(),
                    status: "error".to_string(),
                    message: Some("Missing session_id".to_string()),
                    ..Default::default()
                }
            } else if target_user == user_id && target_session == session_id {
                AdminResponse {
                    msg_type: "admin_response".to_string(),
                    action: "disconnect_session".to_string(),
                    status: "error".to_string(),
                    message: Some("Cannot disconnect yourself".to_string()),
                    ..Default::default()
                }
            } else {
                let found = state.disconnect_session(&target_user, &target_session);
                if found {
                    println!("Admin {} disconnected session {} of user {}", user_id, target_session, target_user);
                    AdminResponse {
                        msg_type: "admin_response".to_string(),
                        action: "disconnect_session".to_string(),
                        status: "ok".to_string(),
                        message: Some(format!("Session {} disconnected for user {}", target_session, target_user)),
                        ..Default::default()
                    }
                } else {
                    AdminResponse {
                        msg_type: "admin_response".to_string(),
                        action: "disconnect_session".to_string(),
                        status: "error".to_string(),
                        message: Some(format!("Session {} not found for user {}", target_session, target_user)),
                        ..Default::default()
                    }
                }
            }
        }
        "get_system_info" => {
            let info = collect_system_info().await;
            AdminResponse {
                msg_type: "admin_response".to_string(),
                action: "get_system_info".to_string(),
                status: "ok".to_string(),
                message: Some("System info collected".to_string()),
                system_info: Some(info),
                ..Default::default()
            }
        }
        "get_traffic_stats" => {
            let traffic_resp = state.traffic.lock().unwrap().build_response(admin_cmd.limit);
            AdminResponse {
                msg_type: "admin_response".to_string(),
                action: "get_traffic_stats".to_string(),
                status: "ok".to_string(),
                message: Some(format!("Traffic stats: {} active session(s)", traffic_resp.users.len())),
                traffic: Some(serde_json::to_value(traffic_resp).unwrap_or_default()),
                ..Default::default()
            }
        }
        "get_traffic_history" => {
            let to_ms = traffic::now_ms() as i64;
            // from_ms 由客户端明确传入；不传则默认查最近 1 小时
            let from_ms = admin_cmd.from_ms.unwrap_or(to_ms - 3_600_000);
            let page = admin_cmd.page;
            let page_size = admin_cmd.page_size;
            let target_user_id = admin_cmd.user_id.clone();

            let (history_result, total, total_inbound, total_outbound, total_relay, total_handshake) = if let Some(ref db_tx) = state.db_tx {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let _ = db_tx.try_send(crate::db_actor::DbCommand::QueryTrafficHistory {
                    from_ms,
                    to_ms,
                    user_id: target_user_id.clone(),
                    page,
                    page_size,
                    reply: tx,
                });

                match rx.await {
                    Ok(Ok(data)) => data,
                    Ok(Err(e)) => (
                        vec![serde_json::json!({"error": format!("Query failed: {}", e)})],
                        0, 0, 0, 0, 0,
                    ),
                    Err(e) => (
                        vec![serde_json::json!({"error": format!("Channel error: {}", e)})],
                        0, 0, 0, 0, 0,
                    ),
                }
            } else {
                (Vec::new(), 0, 0, 0, 0, 0)
            };

            AdminResponse {
                msg_type: "admin_response".to_string(),
                action: "get_traffic_history".to_string(),
                status: "ok".to_string(),
                message: Some(format!("Found {} history record(s) in range [{} ~ {}]", history_result.len(), from_ms, to_ms)),
                history: Some(history_result),
                total: Some(total),
                page: Some(admin_cmd.page),
                page_size: Some(admin_cmd.page_size),
                total_inbound_bytes: Some(total_inbound),
                total_outbound_bytes: Some(total_outbound),
                total_relay_forwarded_bytes: Some(total_relay),
                total_handshake_bytes: Some(total_handshake),
                ..Default::default()
            }
        }
        "get_system_stats_history" => {
            let limit = admin_cmd.limit.unwrap_or(60);
            let stats_result: Vec<serde_json::Value> = if let Some(ref db_tx) = state.db_tx {
                let (tx, rx) = tokio::sync::oneshot::channel();
                let _ = db_tx.try_send(crate::db_actor::DbCommand::QuerySystemStatsHistory {
                    limit,
                    reply: tx,
                });

                match rx.await {
                    Ok(Ok(rows)) => rows.iter().map(|r| serde_json::json!({
                        "recordedAt": r.recorded_at,
                        "cpuUsagePercent": r.cpu_usage_percent,
                        "memoryUsagePercent": r.memory_usage_percent,
                    })).collect(),
                    Ok(Err(e)) => {
                        vec![serde_json::json!({"error": format!("Query failed: {}", e)})]
                    }
                    Err(e) => {
                        vec![serde_json::json!({"error": format!("Channel error: {}", e)})]
                    }
                }
            } else {
                Vec::new()
            };
            AdminResponse {
                msg_type: "admin_response".to_string(),
                action: "get_system_stats_history".to_string(),
                status: "ok".to_string(),
                message: Some(format!("Found {} system stats record(s)", stats_result.len())),
                system_stats: Some(stats_result),
                ..Default::default()
            }
        }
        "set_user_relay_quota" => {
            let target_user = admin_cmd.user_id.clone().unwrap_or_default();
            if target_user.is_empty() {
                AdminResponse {
                    msg_type: "admin_response".to_string(),
                    action: "set_user_relay_quota".to_string(),
                    status: "error".to_string(),
                    message: Some("Missing user_id".to_string()),
                    ..Default::default()
                }
            } else if let Some(quota_bytes) = admin_cmd.quota_bytes {
                let quota = state.set_user_relay_quota(&target_user, quota_bytes);
                println!("Admin {} set user {} relay quota to {} bytes", user_id, target_user, quota_bytes);
                AdminResponse {
                    msg_type: "admin_response".to_string(),
                    action: "set_user_relay_quota".to_string(),
                    status: "ok".to_string(),
                    message: Some(format!("User {} relay quota set to {} bytes", target_user, quota_bytes)),
                    quota: Some(serde_json::to_value(quota).unwrap_or_default()),
                    ..Default::default()
                }
            } else {
                AdminResponse {
                    msg_type: "admin_response".to_string(),
                    action: "set_user_relay_quota".to_string(),
                    status: "error".to_string(),
                    message: Some("Missing quota_bytes".to_string()),
                    ..Default::default()
                }
            }
        }
        "get_user_relay_quota" => {
            if let Some(user_ids) = admin_cmd.user_ids {
                let mut quotas = Vec::new();
                for tid in user_ids {
                    let q = state.get_or_create_user_quota(&tid);
                    quotas.push(serde_json::to_value(q).unwrap_or_default());
                }
                AdminResponse {
                    msg_type: "admin_response".to_string(),
                    action: "get_user_relay_quota".to_string(),
                    status: "ok".to_string(),
                    message: Some(format!("Fetched {} user relay quota(s)", quotas.len())),
                    quotas: Some(quotas),
                    ..Default::default()
                }
            } else {
                let target_user = admin_cmd.user_id.clone().unwrap_or_default();
                if target_user.is_empty() {
                    AdminResponse {
                        msg_type: "admin_response".to_string(),
                        action: "get_user_relay_quota".to_string(),
                        status: "error".to_string(),
                        message: Some("Missing user_id or user_ids".to_string()),
                        ..Default::default()
                    }
                } else {
                    let quota = state.get_or_create_user_quota(&target_user);
                    AdminResponse {
                        msg_type: "admin_response".to_string(),
                        action: "get_user_relay_quota".to_string(),
                        status: "ok".to_string(),
                        message: Some(format!("User {} relay quota", target_user)),
                        quota: Some(serde_json::to_value(quota).unwrap_or_default()),
                        ..Default::default()
                    }
                }
            }
        }
        _ => {
            let action_name = admin_cmd.action.clone();
            AdminResponse {
                msg_type: "admin_response".to_string(),
                action: admin_cmd.action,
                status: "error".to_string(),
                message: Some(format!("Unknown admin action: {}", action_name)),
                ..Default::default()
            }
        }
    }
}
