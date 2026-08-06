# server/rust 服务端模块上下文

> 本文档供 AI 阅读，用于快速理解 `server/rust/src` 服务端实现的整体架构与实现细节，无需逐文件阅读源码即可进行代码更新。
> 本模块与客户端 `nos/user` 是**联动的服务端实现**，协议对应关系见第六节。

## 一、整体架构

NoneOS Handshake Server 是一个基于 **Tokio + tokio-tungstenite** 的异步 WebSocket 服务，负责：身份验签握手、用户会话管理、消息中继（Relay）、流量统计与配额、管理命令、系统监控。持久化使用嵌入式 **redb** 数据库，并发会话使用 **DashMap**。

### 核心设计

1. **单文件全生命周期**：`handler.rs::handle_connection` 从 WebSocket 升级 → 挑战 → 验签 → 注册 → 消息循环 → 清理，串起整个连接生命期。
2. **内存态会话 + 持久化统计**：在线会话全部驻留 `DashMap`，每 `traffic_flush_interval_secs`（默认 30s）将流量与系统快照刷入 redb。
3. **配额与防滥用**：每用户默认 500MB 中继配额；另有服务器整体月度流量限额（`global_relay_quota_bytes`，默认 0 = 不限制）；任一超限后仅允许 ≤1KB 小消息；中继失败 10 次/60s 踢出；内存占用 ≥95% 拒绝非 admin 新连接。
4. **二进制中继帧**：`[4B header_len BE][header JSON][payload]`，与客户端约定，避免大 payload JSON 序列化。
5. **心跳**：服务端每 15s 发 Ping；若 60s 内未收到任何客户端消息则断开（活动判定不限于 Pong，任意客户端消息均更新 `last_activity_at`）。

## 二、模块地图

```
server/rust/
├── Cargo.toml              # 依赖清单
├── CONTEXT.md              # 本文档
└── src/
    ├── main.rs             # 入口：解析参数 → 加载配置 → 打开 redb → 启动 AppState → flush 定时器 → accept 循环 + 优雅关闭
    ├── config.rs           # Args(clap) + Config(TOML) + 各项默认值
    ├── handler.rs          # 核心：UserSession/AppState + 连接生命周期 + 消息分发 + 中继/配额/防滥用
    ├── admin.rs            # AdminCommand/AdminResponse + 12 个管理动作 + 系统信息采集
    ├── crypto.rs           # ECDSA P-256 验签（p256 crate，Base64 SPKI 公钥 + 64B raw 签名）
    └── traffic.rs          # redb 表定义 + TrafficStats 流量统计 + 计费周期用量（含重置日历法计算与单元测试） + 系统快照 + 用户持久化
```

## 三、核心数据结构

### AppState（handler.rs）

| 字段 | 类型 | 说明 |
|------|------|------|
| `admin_user_id` | `Option<String>` | 管理员 userId（从 config 注入） |
| `config` | `Config` | 全局配置 |
| `traffic` | `TrafficStats` | 流量统计聚合体 |
| `user_quotas` | `DashMap<String, traffic::UserRecord>` | 用户记录缓存（含 user_id/username/public_key/first_seen_at/last_seen_at/quota_bytes/used_bytes） |
| `db` | `Arc<redb::Database>` | 持久化句柄（Arc 共享） |
| `users` | `DashMap<String, UserSession>` | key = `userId:sessionId` |
| `user_session_counts` | `DashMap<String, usize>` | 每用户会话计数，用于 `max_sessions_per_user` |

### UserSession（handler.rs）

| 字段 | 说明 |
|------|------|
| `username` / `host` / `addr` | 用户标识与网络地址 |
| `disconnect_tx` | `Option<oneshot::Sender<()>>` | 主动踢出信号（一次性，取走后变 None） |
| `data_tx` | `mpsc::UnboundedSender<Message>` | 中继转发数据下发通道（无界） |
| `latency_ms` | 最近一次延迟测速结果 |
| `connected_at` | 连接时间戳 |
| `relay_fail_count` / 窗口 | 中继失败计数（超限踢出） |
| `services` | 该会话注册的应用服务列表（来自 `update_services`） |

### TrafficStats（traffic.rs）

- `sessions: DashMap<String, SessionTraffic>` —— 每会话双向字节计数（AtomicU64）
- `global` 全局 AtomicU64 + 区间 delta
- `period: AtomicPeriodUsage` —— 当前计费周期的服务器整体用量（inbound/outbound + `period_start_ms`），供 `global_relay_quota_bytes` 限额判定
- `user_traffic_map`、`minute_buckets` —— 聚合写入用
- `perform_flush()` 每 30s 调用，写入 redb 三张表

## 四、关键 API / 消息分发

### 连接生命周期（handle_connection）

1. WebSocket 升级，捕获 `Origin` 头存入 `UserSession.host`。
2. 内存过载保护检查（非 admin 且内存 ≥ `max_memory_usage_percent` 拒绝连接）。
3. **先发送** `handshake_challenge`（32 字节随机字符串），**再等待**客户端响应（超时 `handshake_timeout_secs`）。
4. 收到签名 → `crypto::verify_signature` 验签 → 失败断开。
5. `add_user` 注册：检查 `max_sessions_per_user`，重连时踢旧连接；调用 `traffic.register_session` + `traffic.add_handshake`；持久化用户到 redb（保留 used_bytes/quota_bytes）。
6. 进入消息循环（select），分支：
   - `disconnect_rx` —— 接收踢出信号
   - `data_rx` —— 接收中继转发通道数据
   - WebSocket 消息按类型分发：
     - `admin` —— 转发 admin 命令
     - `query` —— 查询（如在线状态）
     - `update_services` —— 更新会话服务列表
     - `relay` —— 中继（文本/二进制）
     - `latency_test` / `latency_report` —— 延迟测速
7. 退出循环 → 清理会话 → 最终 flush。

### 中继流程（relay_deliver_and_finalize）

1. `check_relay_quota`：admin 全放；服务器整体月度配额超限或用户配额超限时，仅放 ≤ `relay_small_message_max_bytes`；否则放行。
2. 查找目标 `userId:sessionId` → 通过 `data_tx` 投递；`silent: bool` 参数控制成功是否返回 `relay_response`。
3. **成功**才记录流量（`traffic.add_relay_forwarded` + `state.record_relay_usage`），并 `reset_relay_failure` 重置失败计数；**失败不记录流量**。
4. 失败累加 `relay_fail_count`，达 `relay_fail_limit`/`relay_fail_window_secs` 踢出。

### 二进制中继帧解析

```
[4B header_len BE][header JSON][payload]
```

header 含 from/to/sessionId 等路由字段，payload 为原始字节，直接透传不参与 JSON 序列化。

### AdminCommand（admin.rs）

| action | 说明 |
|--------|------|
| `list_users` | 当前在线用户分页 |
| `list_user_groups` | 按 userId 聚合 |
| `list_all_users` | 含历史用户（redb `load_all_users`，按 last_seen_at desc） |
| `disconnect_user` / `disconnect_session` | 踢出 |
| `get_system_info` | 内存/CPU 核数/磁盘 |
| `get_traffic_stats` | 实时流量 |
| `get_traffic_history` | **已废弃**，仅返回空数组与提示信息（数据需从 redb 文件导出分析） |
| `get_system_stats_history` | 历史 CPU/内存 |
| `set_user_relay_quota` / `get_user_relay_quota` | 配额管理 |
| `get_global_relay_quota` | 查询服务器整体月度配额：`quota.quotaBytes` / `usedBytes` / `inboundBytes` / `outboundBytes` / `periodStartAt` / `periodResetDay` / `remainingBytes` / `unlimited` / `exceeded` |

`get_memory_usage_percent` 带 1s 缓存，供 95% 过载拒绝使用。

## 五、关键实现细节

### 1. 验签（crypto.rs）

- 输入：`public_key_b64`（SPKI Base64）、`message`、`signature_b64`（64 字节 raw R||S）。
- 流程：Base64 解码公钥 → `VerifyingKey`；Base64 解码签名 → `Signature`；SHA-256 验签。
- 与客户端 `BaseUser._sign` 对应：客户端按 key 字母序排序 JSON 后签名，服务端只验签不参与排序（消息原文由客户端构造）。

### 2. redb Schema（traffic.rs）

| 表 | Key | Value | 说明 |
|----|-----|-------|------|
| `USERS` | `&str`(userId) | bincode(`UserRecord`: user_id/username/public_key/first_seen_at/last_seen_at/quota_bytes/used_bytes) | 用户持久化 |
| `USER_TRAFFIC_DIST` | `(ts_30s, from, to)` | bytes | 用户间流量分布 |
| `GLOBAL_DATA` | `"total_inbound"` / `"total_outbound"` / `"total_relay"` / `"period_inbound"` / `"period_outbound"` / `"period_start"`（6 个独立字符串 key） | u64 | 全局累计流量 + 当前计费周期用量 |
| `GLOBAL_TRAFFIC_DIST` | `ts_30s` | (in, out, relay) | 全局流量时间分布（累加） |
| `SYSTEM_STATS` | `ts_30s` | (cpu, mem) | 系统快照 |

- `ts_30s`：30 秒对齐时间戳桶。
- `perform_flush` 每 `traffic_flush_interval_secs` 写入。
- `write_system_stats` 采集 CPU/内存快照。
- `save_user`/`load_user`/`load_all_users` 维护用户表。

### 3. 防滥用与过载保护

- **会话数上限**：`max_sessions_per_user`（默认 10），重连踢旧。
- **中继失败窗口**：`relay_fail_limit`(10) / `relay_fail_window_secs`(60) → 踢出。
- **内存过载**：`max_memory_usage_percent`(95.0) → 拒绝非 admin 新连接。
- **配额**：`default_relay_quota_bytes`(500MB) + `relay_small_message_max_bytes`(1KB) 超额小消息豁免。
- **服务器整体月度限额**：`global_relay_quota_bytes`(默认 0 = 不限制)，统计口径 = 当前计费周期的 `inbound + outbound`（贴近真实带宽账单）。超限后所有非 admin 中继降级为仅放行小消息，WebRTC 信令/名片交换仍可通行，用户可继续走 P2P 直连。周期用量由 flush 定时器调用 `roll_period_if_needed` 在进入新周期时归零；周期边界由 `quota_period_reset_day`(默认 1，即每月几号) 决定，归零时刻为**服务器本地时区**当天 00:00（`period_start_ms(ts, reset_day)`，本地偏移经 libc `localtime_r` 获取，含夏令时；月份天数不足时自动取当月最后一天）；`total_*` 永久累计数不受重置影响。
- **心跳**：`heartbeat_interval_secs`(15) Ping / `heartbeat_timeout_secs`(60) 断开。

### 4. 优雅关闭（main.rs）

- 监听 `Ctrl+C` + `tokio::sync::Notify`。
- 退出前执行最后一次 `perform_flush`（不写 system stats）。
- accept 循环退出后直接 drop tokio runtime，**现有连接由 runtime drop 时强制终止**（不等待处理完成）。

### 5. 定时器（handle_flush_timer）

- 每 `traffic_flush_interval_secs` 触发。
- 先调用 `roll_period_if_needed` 检查是否进入新计费周期（是则重置月度用量），再取出 delta/用户流量/全局与周期快照，然后采集 CPU/内存（sysinfo），最后在同一个 `spawn_blocking` 中**先 `perform_flush` 再 `write_system_stats`**。

## 六、客户端-服务端协议对应表

| 服务端处理 | 消息类型 | 客户端对应（见 nos/user/CONTEXT.md） |
|-----------|---------|--------------------------------------|
| `handle_connection` 验签 | `handshake_challenge` → 签名 | `ServerManager.connect` 握手应答 |
| `relay` 分支 + `relay_deliver_and_finalize` | `relay` JSON / 二进制帧 | `ServerManager.sendToUser` 中继 |
| 透传中继 | `rtc_signal` | `RTCManager` 信令 |
| 透传中继 | `card` | `CardManager` 名片交换 |
| 透传中继 | `__service_query`/`__service_response` | `RemoteUser.getServiceSessions` |
| `update_services` 分支 | `update_services` | `ServiceRegistry.#syncToServer` |
| 透传中继 | `__app`/`__data` 包裹 | `RemoteUser.sendToService` |
| `latency_test`/`latency_report` 分支 | `latency_test` → `latency_test_response` → `latency_report` | `ServerManager.testLatency` |
| AdminCommand 路由 | HTTP `/admin?...` | `AdminUser.#adminCommand` |
| Ping/Pong | WS Ping | 客户端自动响应 |

## 七、配置默认值（config.rs）

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `port` | 8081 | 监听端口 |
| `host` | `""` | 监听地址（空=全地址） |
| `handshake_timeout_secs` | 5 | 握手超时（秒） |
| `handshake_max_size` | 1KB | 握手消息上限 |
| `text_message_max_size` | 256KB | 文本消息上限 |
| `binary_payload_max_size` | 256KB | 二进制 payload 上限 |
| `max_sessions_per_user` | 10 | 单用户会话上限 |
| `relay_fail_limit` | 10 | 中继失败上限 |
| `relay_fail_window_secs` | 60 | 失败窗口 |
| `max_memory_usage_percent` | 95.0 | 内存过载阈值 |
| `default_relay_quota_bytes` | 500MB | 默认中继配额 |
| `global_relay_quota_bytes` | 0（不限制） | 服务器整体月度流量限额（口径 = inbound + outbound） |
| `quota_period_reset_day` | 1 | 每月几号重置流量额度（1-31）。归零发生在服务器本地时区当天 00:00；当月天数不足时取最后一天 |
| `relay_small_message_max_bytes` | 1KB | 超额小消息豁免 |
| `redb_path` | `./noneos-handshake.redb` | 数据库路径 |
| `traffic_flush_interval_secs` | 30 | 流量刷盘间隔 |
| `heartbeat_interval_secs` | 15 | Ping 间隔 |
| `heartbeat_timeout_secs` | 60 | 心跳超时 |

启动：`-c/--config` 指定 TOML 配置文件覆盖默认值。

## 八、依赖关系（Cargo.toml）

| crate | 用途 |
|-------|------|
| `tokio` (full) | 异步运行时 |
| `tokio-tungstenite` / `tungstenite` | WebSocket |
| `futures-util` | 异步流处理 |
| `serde` / `serde_json` | 序列化 |
| `toml` | 配置文件解析 |
| `clap` (derive) | 命令行参数 |
| `p256` (ecdsa) | ECDSA P-256 验签 |
| `base64` | Base64 编解码 |
| `sha2` | SHA-256 |
| `rand` | 随机 challenge 生成 |
| `sysinfo` | CPU/内存/磁盘采集 |
| `redb` | 嵌入式 KV 数据库 |
| `bincode` | redb value 二进制序列化 |
| `dashmap` | 并发 HashMap（用户会话表） |
| `libc` | `localtime_r` 读取服务器本地时区偏移（流量额度重置日判定） |

## 九、构建与运行

```bash
cd server/rust
cargo build --release
./target/release/noneos-handshake -c config.toml
```
