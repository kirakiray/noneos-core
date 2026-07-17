# nos/user 用户模块上下文

> 本文档供 AI 阅读，用于快速理解 `nos/user` 模块的整体架构与实现细节，无需逐文件阅读源码即可进行代码更新。
> 本模块与服务端 `server/rust/src` 是**联动的客户端实现**，协议对应关系见第六节。

## 一、整体架构

NoneOS 用户系统基于 **ECDSA P-256** 公私钥对建立身份（`userId = hash(publicKey)`），通过 WebSocket 与服务端握手建立长连接，再通过服务端中继（Relay）或 WebRTC DataChannel（P2P）与其他用户通信，通信内容默认端到端加密（E2EE）。

### 核心设计

1. **分层身份**：`BaseUser` 封装签名/验签能力；`LocalUser` 扩展出证书、名片、服务器、RTC、服务注册等管理器；`AdminUser` 增加管理命令；`RemoteUser` 代表对端用户。
2. **多服务器多会话**：单个用户可同时连接多个服务器（dev/prod 多区域），每个浏览器标签页生成独立 `sessionId`，通过 `BroadcastChannel` 跨标签页发现。
3. **三种传输路径**：
   - 服务器中继（文本 JSON / 二进制帧）—— 默认通道
   - WebRTC DataChannel（P2P 直连，ordered）—— 延迟敏感场景
   - 服务端 admin HTTP 命令 —— 仅 AdminUser
4. **E2EE 建链**：握手 → 名片交换（Card，含双方公钥签名）→ ECDH 派生密钥 → AES-GCM 加密 P2P 消息。
5. **应用层路由**：通过 `__app`/`__data` 包裹业务消息，`ServiceRegistry` 在应用层（appId）维度路由；服务发现使用 `__service_query`/`__service_response`。

## 二、模块地图

```
nos/user/
├── main.js                  # 入口：getUser/exportUser/importUser/deleteUser + 实例缓存
├── base-user.js             # BaseUser：签名/验签、事件分发
├── user.js                  # LocalUser：核心类，聚合所有管理器 + 中继/RTC 分发
├── admin-user.js            # AdminUser extends LocalUser：管理命令封装
├── remote-user.js           # RemoteUser extends BaseUser：对端用户、send/RTT/服务查询
├── server.js                # ServerManager：WebSocket 连接、握手、延迟选路
├── rtc.js                   # RTCManager：WebRTC DataChannel P2P 连接
├── card.js                  # CardManager：名片交换协议（E2EE 密钥派生前置）
├── cert.js                  # CertManager：证书签发/导入/查询（PKI）
├── service-registry.js      # ServiceRegistry：应用级服务注册与路由
├── traffic.js               # TrafficLogger：客户端流量记录与查询
├── db.js                    # IndexedDB 持久化（data/certs/cards/traffic_entries/traffic_agg_minute 五仓库）
├── README.md                # API 文档（人类阅读）
└── CONTEXT.md               # 本文档
```

## 三、类继承关系

```
EventTarget
  └── BaseUser (base-user.js)            ← #signer/#verifier/#userId/#privateKey/#publicKey
        ├── LocalUser (user.js)          ← 聚合 CertManager/CardManager/ServerManager/RTCManager/ServiceRegistry
        │     └── AdminUser (admin-user.js)  ← #adminCommand(url, action, extra)
        └── RemoteUser (remote-user.js)  ← #sessions Map<sessionId, {url}>、#pendingPings、E2EE 解密
```

- `BaseUser.init(keys)`：由 publicKey 构造 `verifier`；若同时提供 privateKey 则构造 `signer`，并校验公私钥匹配。
- `BaseUser._sign(data)`：注入 `signTime` 与 `publicKey`，**按 key 字母序排序后 JSON.stringify** 再签名，返回 base64 签名。
- `BaseUser.verify(signedData)`：剥离 `signature` 字段后按相同规则验签。

## 四、关键 API

### 入口层（main.js）

| 函数 | 说明 |
|------|------|
| `getUser(namespace)` | 获取/创建 LocalUser 实例（Map 缓存，`initPromises` 防并发初始化） |
| `exportUser(namespace)` | 导出私钥（用于迁移） |
| `importUser(namespace, privateKey)` | 导入私钥恢复用户 |
| `deleteUser(namespace)` | 删除用户（i18n 确认 zh/ja/en，删除 IndexedDB `nos_user_${namespace}`）；若内存已有 LocalUser 实例，会先 `traffic.setEnabled(false)` + `server.disconnectAll()` + `traffic.flush()` 再关闭 db 缓存，避免后台埋点重开数据库触发 `onblocked` |

### LocalUser（user.js）

| 方法/属性 | 说明 |
|-----------|------|
| `#sessionId` | `"s-" + Math.random().toString(36).slice(2)`，每标签页唯一 |
| `connectUser(userId)` | 连接远端用户：`#server.findBestServer()` 选路，最多重试 5 次；成功触发 `remote_user_connected` |
| `disconnectUser(userId)` | 断开远程用户并清理缓存，触发 `remote_user_disconnected`（`reason: "manual"`） |
| `getSessionIds()` | 通过 BroadcastChannel 跨标签页收集本用户所有 sessionId |
| `remoteUsers` | 只读 getter，返回当前已缓存的 `RemoteUser[]` 快照（主动连接 + 收到消息后被动创建） |
| `isRemoteUserOnline(userId)` | 查询指定 userId 当前是否在线（已缓存走 `RemoteUser.getSessionIds()`，未缓存直接查服务器） |
| `getRemoteUsers({ onlineOnly })` | 返回已缓存 `RemoteUser[]`；`onlineOnly: true` 时过滤当前在线用户 |
| `#setupRelayDispatch()` | 处理中继文本（JSON）与二进制帧 |
| `#setupRTCDispatch()` | 处理 RTC DataChannel 消息，E2EE 解密后分发 |
| `#dispatchToRemote()` | 分发优先级：`__service_query` → `__service_available/unavailable` → `__app` 消息 → RemoteUser 缓存；被动消息自动创建缓存；未注册的 `__app` 消息触发 `unhandled_service_message` 事件 |
| `#ensureRemoteUser(userId, initiatedBy)` / `_ensureRemoteUser(...)` | 内部辅助与供管理器调用的包装：确保 RemoteUser 存在，新创建时触发 `remote_user_connected` |
| `cert` / `card` / `server` / `rtc` / `services` / `traffic` | 各管理器实例 |

### RemoteUser（remote-user.js）

| 方法 | 说明 |
|------|------|
| `send(sessionId, data, raw=false)` | RTC 优先、服务端中继兜底；普通对象走 E2EE；第 2 次发送触发 RTC 建链 |
| `sendToService(appId, data, options)` | 默认精准投递：先服务发现（含 30s 缓存 + `__service_available` 推送）→ 只发到装了 appId 的 session。`waitForService` 允许挂起等待对端上线；`fallback:"broadcast"` 兜底老式广播。返回 `{ok/no_receiver/offline/discovery_failed/error}` 明确状态 |
| `getServiceSessions(appId)` | `__service_query`/`__service_response` 查询对端服务会话（sendToService 内部使用） |
| `getRTT(sessionId?)` | 返回 `{rtt, via, url}`，不传则返回所有会话中最优 |
| `#pendingPings` | Map<pingId, timestamp>，Ping/Pong RTT 测量 + 超时清理 |

### ServerManager（server.js）

| 方法 | 说明 |
|------|------|
| `connect(url, optionsOrRetries?)` | 建立 WebSocket，自动执行握手挑战应答；第二个参数支持 `{ retries }` 或旧版的数字重试次数 |
| `setAutoReconnect(options)` | 配置自动重连：enabled/baseDelay/maxDelay/multiplier/maxRetries，默认关闭 |
| `disconnect(url)` | 断开指定服务器，并停止该 URL 的自动重连 |
| `sendToUser(targetUserId, targetSessionId, data)` | 自动选最优服务器发送，支持二进制中继帧 |
| `findBestServer(targetUserId)` | 返回**本端+对端组合延迟**最低的服务器 |
| `#getSortedServerCandidates(targetUserId)` | 组合延迟排序，15s TTL 缓存 |
| `testLatency(url)` | 三段式：`latency_test` → `latency_test_response` → `latency_report` |
| 延迟监控 | 页面隐藏时检测间隔扩大 5 倍 |

### 其他管理器

| 管理器 | 关键方法 |
|--------|---------|
| `CertManager` (cert.js) | `issue`/`import`/`has`/`get`/`delete`/`count`/`values`；证书 ID = `${role}-${issuer}-${subject}`；导入校验：字段完整性、publicKey→userId 哈希、签名、signTime 新旧替换、拒绝未来时间 |
| `CardManager` (card.js) | `start()` 监听中继 `type:"card"`；收到名片请求/响应时调用 `_ensureRemoteUser()` 建立 RemoteUser；`get(userId)` DB 优先 → 网络请求（10s 超时）；`requestCard` 流程：connectUser → findSessionId → 发请求 |
| `RTCManager` (rtc.js) | 信令经中继 `rtc_signal`（offer/answer/ice）；`iceServers: []`（仅靠服务端中继，无 STUN/TURN）；DataChannel `"noneos"` ordered |
| `ServiceRegistry` (service-registry.js) | `register(appId, {exposeToServer, onMessage})` 重复抛错；`#syncToServer()` 向所有服务器发 `update_services`；`register/unregister` 时向 `localUser.remoteUsers` 广播 `__service_available`/`__service_unavailable`，并触发本地 `service_registered`/`service_unregistered` 事件 |

## 五、关键实现细节

### 1. 握手挑战应答（server.js）

1. 连接 WebSocket 后等待服务端推送 `handshake_challenge`（含随机 challenge）。
2. 用本地私钥对 challenge 签名，回发签名。
3. 服务端验签通过后推送 `handshake` 成功事件（含 userId 等）。
4. 失败触发 `ws_error` 事件。

### 2. 自动重连（server.js）

- 默认关闭，通过 `setAutoReconnect({ enabled: true, baseDelay, maxDelay, multiplier, maxRetries })` 开启。
- 仅在手**握手成功后的 `WebSocket.onclose`** 触发重连，握手阶段失败仍由 `connect()` 内部重试处理。
- 指数退避：第 `n` 次重连间隔为 `min(baseDelay * multiplier^(n-1), maxDelay)`。
- 同一 URL 的并发连接通过 `#connectPromises` 复用 Promise；`#reconnectTasks` 管理重连定时器，避免重复调度。
- 调用 `disconnect(url)` 会标记该 URL 为“用户主动断开”，清除待执行重连任务，关闭后不再自动重连。
- 显式调用 `connect(url)` 会解除“主动断开”标记并取消待执行重连。

### 3. 中继消息格式（user.js / server.js）

- **文本中继**：JSON 对象，含 `type`、`from`、`to`、`sessionId` 等字段。例如 `card`、`rtc_signal`、`relay`、`__service_query`、`__service_response`、`update_services`。
- **二进制中继帧**：`[4B header_len BE][header JSON][payload]`，header 含路由信息。用于大 payload（如文件块），避免 JSON 序列化开销。

### 3. WebRTC 建链（rtc.js）

- 信令通道复用服务端中继：`rtc_signal` 消息携带 `{type:"offer"|"answer"|"ice", ...}`。
- **无 STUN/TURN**：`iceServers: []`，仅在 NAT 友好或同局域网可直连；否则降级为中继。
- DataChannel 名 `"noneos"`，`ordered: true`。
- 状态机：connecting → connected → failed/disconnected/closed；失败回退到中继。

### 4. E2EE 端到端加密

- 前置：通过 `CardManager` 交换双方名片（含经签名的公钥），校验 `publicKey → userId` 哈希一致 + 签名有效。
- 密钥派生：双方 `publicKey`/`privateKey` 做 ECDH（P-256）得到共享密钥。
- 加密：AES-GCM，每条消息含 IV/nonce + 密文 + TAG。
- `RemoteUser.send` 对普通对象自动加密；`raw=true` 跳过加密。

### 5. 名片交换协议（card.js）

```
A.get(B.userId)
  └── DB 命中 → 返回
  └── DB 未命中 → requestCard
        ├── connectUser(B.userId)   # 确保对端在线
        ├── findSessionId            # 选一个会话
        ├── 发送 {type:"card", action:"request"}  ──→ B
        └── B 回 {type:"card", action:"response", card} ──→ A
              └── 校验 publicKey→userId + 签名 → 存 DB
```

### 6. 服务注册与发现（service-registry.js + remote-user.js）

- `register(appId, {exposeToServer, onMessage})` 后：
  - 若 `exposeToServer=true`：`#syncToServer()` 向所有连接的服务器发送 `update_services`
  - 无论是否暴露给服务端：向所有已缓存的 `RemoteUser` 广播 `__service_available`，让对端立即更新其 `serviceSessionCache`
  - 触发本地事件 `service_registered`
- `unregister(appId)` 对称地广播 `__service_unavailable`，并触发 `service_unregistered`
- 业务消息包裹：`{__app: appId, __data: {...}}`
- `RemoteUser.sendToService` 默认精准投递：
  1. 命中 `serviceSessionCache`（TTL 30s，或对端主动推送刷新）→ 直接投递
  2. 未命中 → `getSessionIds` 拿到对端所有 session，再走 `__service_query` 询问，写入缓存
  3. `sessions.length === 0` 且 `waitForService > 0` → 等待对端 `__service_available` 推送后再投递
  4. 完全离线 → 返回 `{status:"offline"}`；服务发现失败 → 返回 `{status:"discovery_failed"}`（可通过 `fallback:"broadcast"` 兜底）
- 显式指定 `sessionId` 时保持原语义：直接透传，不做服务发现，接收方未注册则触发 `unhandled_service_message` 事件

### 7. IndexedDB Schema（db.js）

- 数据库名：`nos_user_${namespace}`，`DB_VERSION = 6`
- 五仓库：
  - `data`：用户信息、密钥、服务器列表等键值
  - `certs`：keyPath `"id"`，7 个索引（role/issuer/subject 及 4 个复合索引）
  - `cards`：keyPath `"userId"`
  - `traffic_entries`：keyPath `"id"`（自增），流量明细，索引 `ts / peer_ts / via_ts / dir_ts / cat_ts / app_ts / server_ts`
  - `traffic_agg_minute`：keyPath `"id"` = `"${bucket}|${peerUserId}|${via}|${serverUrl}|${category}"`，分钟聚合桶
- 连接缓存 5s 自动关闭，避免长期占用。
- `saveCardToDb`：保留 `signTime` 更大的名片。

### 8. 流量记录（traffic.js）

- **埋点位置**：入站在 [user.js #setupRelayDispatch / #setupRTCDispatch](./user.js)；出站在 [server.js sendToServer](./server.js)（含握手响应）+ [remote-user.js RTC 分支](./remote-user.js)。
- **记录内容**：仅元数据 + 链路字节数（`size`），从不记录消息内容。
- **字段**：`ts / direction / peerUserId / sessionId / via / serverUrl / size / category / messageType / appId / success / errorCode`。
- **category 枚举**：`app / service / card / rtc_signal / handshake / latency / control / relay / other`。
- **失败记录**：`success: false`，`size` 为尝试发送字节，`errorCode` 记原因（如 `not_open`）。
- **批量刷盘**：默认 500ms 或积累 50 条触发；`clearAll/deleteBefore/delete` 之前会 `flush()`。
- **聚合桶**：`peerUserId × via × serverUrl × category`，按分钟对齐。**不含 appId 维度**，按 app 查询走明细表 `by_app_ts` 索引。
- **主要 API**：`record / flush / query / summary / getPeerTotals / getServerTotals / getTimeline / getTotalStats / count / getStorageInfo / deleteBefore / delete / clearAll / setEnabled / configure`。
- **数据保留**：默认永久保留，通过 `deleteBefore(ts)` / `delete(filter)` / `clearAll()` 由上层清理应用管理。

## 六、客户端-服务端联动协议对应表

| 客户端行为 | 传输 | 消息类型 | 服务端处理（见 server/rust/CONTEXT.md） |
|-----------|------|---------|----------------------------------------|
| 握手应答 | WS 文本 | `handshake_challenge` → 签名回发 | `handle_connection` 验签注册 |
| 中继发送 | WS 文本/二进制 | `relay` JSON / 二进制帧 | `relay` 分支 + `relay_deliver_and_finalize` |
| RTC 信令 | 中继 | `rtc_signal` (offer/answer/ice) | 透传中继 |
| 名片交换 | 中继 | `card` (request/response) | 透传中继 |
| 服务发现 | 中继 | `__service_query`/`__service_response`/`__service_available`/`__service_unavailable` | 透传中继 |
| 服务上报 | WS 文本 | `update_services` | `update_services` 分支，存入 UserSession.services |
| 应用消息 | 中继 | `__app`/`__data` 包裹 | 透传中继 |
| 延迟测速 | WS 文本 | `latency_test` → `latency_test_response` → `latency_report` | `latency_test`/`latency_report` 分支 |
| 管理命令 | HTTP | `/admin?...` | AdminCommand 路由（见 admin.rs） |
| 心跳 | WS Ping | —— | 服务端 15s Ping / 60s 超时 |

## 七、依赖关系

- `../util/hash/get-hash.js` —— userId 派生
- `../fs/main.js` —— 远端用户文件系统（动态导入 `./fs-remote/main.js`）
- 浏览器 API：WebSocket、WebRTC（RTCPeerConnection/DataChannel）、IndexedDB、BroadcastChannel、Crypto.subtle（ECDSA/ECDH/AES-GCM）

## 八、事件清单

| 事件名 | 触发时机 |
|--------|---------|
| `handshake` | 服务端握手成功 |
| `server_connected` | 服务器握手成功（首次或重连成功） |
| `server_disconnected` | 握手成功后连接断开 |
| `server_reconnecting` | 已安排下一次自动重连 |
| `server_reconnect_exhausted` | 自动重连达到最大次数 |
| `ws_error` | WebSocket 或握手错误 |
| `message` | 收到中继消息（解密后） |
| `close` | 连接关闭 |
| `latency_test` / `latency_monitor` / `rtt_update` | 延迟测速与监控 |
| `rtc_state` | RTC 连接状态变化 |
| `card_received` | 收到对端名片 |
| `remote_user_connected` | RemoteUser 进入缓存：主动 `connectUser()` 成功，或收到对方消息后被动创建。detail: `{ userId, remoteUser, initiatedBy: "local"|"remote" }` |
| `remote_user_disconnected` | RemoteUser 被移除：显式 `disconnectUser()`（`reason: "manual"`），或 `connectUser()` 失败（`reason: "error"`）。detail: `{ userId, remoteUser, reason, error }` |
| `service_registered` / `service_unregistered` | 本地 `ServiceRegistry.register`/`unregister` 成功时触发。detail: `{ appId }` |
| `unhandled_service_message` | 收到 `__app` 消息但本地未注册该 `appId`（含显式 sessionId 定投或对端缓存未刷新）。detail: `{ appId, fromUserId, fromSessionId, data }` |
