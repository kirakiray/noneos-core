# nos/user 用户模块上下文

> 本文档供 AI 阅读，用于快速理解 `nos/user` 模块的整体架构与实现细节，无需逐文件阅读源码即可进行代码更新。
> 本模块与服务端 `server/handshake/src` 是**联动的客户端实现**，协议对应关系见第六节。

## 一、整体架构

NoneOS 用户系统基于 **ECDSA P-256** 公私钥对建立身份（`userId = hash(publicKey)`），通过 WebSocket 与服务端握手建立长连接，再通过服务端中继（Relay）或 WebRTC DataChannel（P2P）与其他用户通信，通信内容默认端到端加密（E2EE）。

### 核心设计

1. **分层身份**：`BaseUser` 封装签名/验签能力；`LocalUser` 扩展出凭证（cred，个人资料 profile + 证书统一）、服务器、RTC、服务注册等管理器；`AdminUser` 增加管理命令；`RemoteUser` 代表对端用户。
2. **多服务器多会话**：单个用户可同时连接多个服务器（dev/prod 多区域），每个浏览器标签页生成独立 `sessionId`，通过 `BroadcastChannel` 跨标签页发现。
3. **三种传输路径**：
   - 服务器中继（文本 JSON / 二进制帧）—— 默认通道
   - WebRTC DataChannel（P2P 直连，ordered）—— 延迟敏感场景
   - 服务端 admin HTTP 命令 —— 仅 AdminUser
4. **E2EE 建链**：握手 → 资料交换（profile，含双方公钥签名）→ ECDH 派生密钥 → AES-GCM 加密 P2P 消息。
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
├── cred.js                  # CredentialManager：凭证统一管理（个人资料 profile + 证书）；统一存储（certs store）与导入路径；含资料在线交换协议
├── service-registry.js      # ServiceRegistry：应用级服务注册与路由
├── traffic.js               # TrafficLogger：客户端流量记录与查询
├── db.js                    # IndexedDB 持久化（data/certs/traffic_entries/traffic_agg_minute 四仓库；个人资料以 role="profile" 记录存于 certs）
├── README.md                # API 文档（人类阅读）
└── CONTEXT.md               # 本文档
```

## 三、类继承关系

```
EventTarget
  └── BaseUser (base-user.js)            ← #signer/#verifier/#userId/#privateKey/#publicKey
        ├── LocalUser (user.js)          ← 聚合 CredentialManager(cred)/ServerManager/RTCManager/ServiceRegistry/TrafficLogger
        │     └── AdminUser (admin-user.js)  ← #adminCommand(url, action, extra)
        └── RemoteUser (remote-user.js)  ← #rttMap/#pendingPings/#serviceSessionCache/#serviceWaiters、E2EE 解密；Ping/Pong RTT、服务发现缓存
```

- `BaseUser.init(keys)`：由 publicKey 构造 `verifier`；若同时提供 privateKey 则构造 `signer`，并校验公私钥匹配。
- `BaseUser._sign(data)`：注入 `signTime` 与 `publicKey`，**按 key 字母序排序后 JSON.stringify** 再签名，返回 base64 签名。
- `BaseUser.verify(signedData)`：剥离 `signature` 字段后按相同规则验签。

## 四、关键 API

### 入口层（main.js）

| 函数 | 说明 |
|------|------|
| `getUser(namespace)` | 获取/创建 LocalUser 实例（Map 缓存，`initPromises` 防并发初始化） |
| `exportUser(namespace, password)` | 用密码加密导出完整用户数据（namespace + keys + info + exportTime），返回加密 base64 字符串 |
| `importUser(namespace, encryptedData, password)` | 解密 `exportUser` 产出的加密数据并恢复用户；若 namespace 已存在则抛错 |
| `deleteUser(namespace)` | 删除用户（i18n 确认 zh/ja/en，删除 IndexedDB `nos_user_${namespace}`）；若内存已有 LocalUser 实例，会先 `traffic.setEnabled(false)` + `server.disconnectAll()` + `traffic.flush()` 再关闭 db 缓存，避免后台埋点重开数据库触发 `onblocked`。**删除前会读取用户库中的 `user-storages` 登记表，对登记的全部存储 id 逐个 `deleteStorage()`，联动清理该用户 `getStorage()` 创建的专属存储** |

### LocalUser（user.js）

| 方法/属性 | 说明 |
|-----------|------|
| `#sessionId` | `"s-" + Math.random().toString(36).substring(2, 10)`（8 字符随机后缀），每标签页唯一 |
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
| `getStorage(name)` | 获取该用户专属的独立存储空间（async，默认 name=`"default"`）。存储 id = `user:<namespace>:<userId>:<name>`，复用 `nos/storage` 的 `getStorage`，不同用户/身份互不可见；创建时经 `addUserStorageId` 登记到用户库，供 `deleteUser` 联动清理 |
| `shareStorage(name)` | 显式开启一个存储空间的共享（**只读**，async）。`name` 必须以 `share:` 开头，否则抛错；经 `addSharedStorage` 登记到用户库 `shared-storages` 键（幂等），返回 revoke 函数（调用 `removeSharedStorage` 关闭共享）。远端用户只能读取已开启的共享空间，无法写入 |
| `cred` / `server` / `rtc` / `services` / `traffic` | 各管理器实例 |

### RemoteUser（remote-user.js）

| 方法 | 说明 |
|------|------|
| `send(sessionId, data, raw=false)` | RTC 优先、服务端中继兜底；普通对象走 E2EE；第 2 次发送触发 RTC 建链 |
| `sendToService(appId, data, options)` | 默认精准投递：先服务发现（含 30s 缓存 + `__service_available` 推送）→ 只发到装了 appId 的 session。`waitForService` 允许挂起等待对端上线；`fallback:"broadcast"` 兜底老式广播。返回 `{ok/no_receiver/offline/discovery_failed/error}` 明确状态 |
| `getServiceSessions(appId)` | `__service_query`/`__service_response` 查询对端服务会话（sendToService 内部使用） |
| ~~`shareCert(cert)`~~ | 已删除：凭证交付统一走 `cred.requestRecord` 按 key 拉取（见「凭证按 key 拉取协议」小节） |
| `getRTT(sessionId?)` | 返回 `{rtt, via, url}`，不传则返回所有会话中最优 |
| `getStorage(name, options?)` | 远端共享存储只读代理：`name` 必须 `share:` 开头（本地预校验抛错），同一 `(userId, name)` 缓存复用；代理方法 `getItem/has/key/length/keys/entries` 走 `__storage_req`（单次尝试默认 10s 超时，`options.timeout` 可调；超时/发送失败自动重发，默认 `options.retries=1`，对端明确回传的错误不重试），`setItem/removeItem/clear` 调用即抛错；失败 Error 带 `code`（`offline/timeout` 本地判定，其余为对端回传错误码，含 `too_large`） |
| `#storageProxies` / `#pendingStorageReqs` | `Map<name, proxy>` 代理缓存；`Map<reqId, {resolve, reject, timeoutId}>` 挂起请求，`__storage_resp` 按 reqId 结算，`dispose()` 清理 |
| `#pendingPings` | `Map<pingId, {sessionId, resolve, reject, timeoutId}>`，Ping/Pong RTT 测量 + 超时清理 |

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
| `CredentialManager` (cred.js，`user.cred`) | **凭证统一管理**：个人资料（profile，role="profile" 自签声明）与证书（他签授权）共用 certs store 与同一条导入路径。**签发与导入**：`issue`/`import`/`importRecord`（返回 `{cert, saved}`）/`saveIfNewer`；证书 ID = `${role}-${issuer}-${subject}`；导入校验：字段完整性、publicKey→issuer 哈希、**规范化排序序列化验签**（与 `_sign` 规则一致）、signTime 新旧替换、拒绝未来时间（`role="profile"` 例外——资料 signTime 仅是版本号，对端时钟偏快不至于卡旧资料）。**过期时间（expire）**：授权类证书的 `expire` 为绝对时间戳、进入签名载荷被签名保护；`issue` 不传默认签发后 30 天，传 `null` 表示永不过期（不携带该字段）；`importRecord` 校验 `expire` 为有效数字、晚于 `signTime` 且未过期（±5 分钟时钟容差），已过期证书拒绝导入，`saveIfNewer` 对过期记录兜底不写入；profile 无过期语义、不参与校验与过滤；无主动清理，惰性判断。`role="profile"` 为保留角色且强制 issuer === subject（自签声明不构成授权）。**查询**：`query`/`has`/`count`/`values`（无参含资料在内的全部记录，仅资料传 `{role:"profile"}`；`query`/`count`/`values` 默认过滤已过期记录，第二参传 `{includeExpired:true}` 才包含）；`query` 传 `{limit}` 即启用 **keyset 分页**，返回 `{items, nextCursor, hasMore}`，`nextCursor` 传回 `{after}` 续读下一页（只能顺序翻页，无 offset；总数需另调 `count()`），不传 `limit` 仍返回全量数组；`delete(id)` 按记录 id 删，`deleteProfile(userId)` 删某用户资料。**凭证在线拉取**：`start()` 监听中继 `type:"cred"`（收到请求/响应时 `_ensureRemoteUser()`）；通用 API `requestRecord(fromUserId, key)`（key 为 `{role, issuer, subject}` 或 id 字符串；connectUser → findSessionId → 发请求，超时/失败自动重发 2 次，幂等，未命中 resolve null）与 `getRecord(fromUserId, key)`（DB 优先 → 网络拉取）、`getRecordByDB(key)`。响应校验记录与 key 一致后走 `importRecord` 统一导入（规范化验签 + signTime 竞争；profile 额外校验 subject === 发送方）。`getProfile`/`requestProfile`/`getProfileByDB` 是通用拉取的薄封装。拉取读回为**签名载荷视图**（剥离外层 `id`），可直接整体验签；完整记录走 `query` |
| `RTCManager` (rtc.js) | 信令经中继 `rtc_signal`（offer/answer/ice）；默认 STUN 服务器（Google/Cloudflare），可通过 `setIceServers`/localStorage `noneos:rtc:ice_servers` 替换；DataChannel `"noneos"` ordered；**Perfect Negotiation**（polite/impolite 由 userId 字典序决定）解决 glare；ICE 候选缓冲（`pendingCandidates`）；`handleSignal` 错误不立即销毁 peer |
| `ServiceRegistry` (service-registry.js) | `register(appId, {exposeToServer, onMessage})` 重复抛错；`#syncToServer()` 向所有服务器发 `update_services`；`register/unregister` 时向 `localUser.remoteUsers` 广播 `__service_available`/`__service_unavailable`，并触发本地 `service_registered`/`service_unregistered` 事件 |

### AdminUser（admin-user.js）

所有方法都经 `#adminCommand(url, action, extra)` 发送 `{type:"admin", action, ...}` 并等待匹配 `action` 的 `admin_response`（失败自动重试一次）。

| 方法 | 对应 action |
|------|------------|
| `listUsers(url, {page, pageSize})` | `list_users` |
| `listUserGroups(url, {page, pageSize})` | `list_user_groups` |
| `listAllUsers(url, {page, pageSize})` | `list_all_users` |
| `disconnectUser(url, userId)` / `disconnectSession(url, userId, sessionId)` | `disconnect_user` / `disconnect_session` |
| `getSystemInfo(url)` | `get_system_info` |
| `getTrafficStats(url, {limit})` | `get_traffic_stats` |
| `getTrafficHistory(url, {...})` | `get_traffic_history`（服务端已废弃，返回空数组） |
| `getSystemStatsHistory(url, {limit})` | `get_system_stats_history` |
| `setUserRelayQuota(url, userId, quotaBytes)` / `getUserRelayQuota(url, userId)` | `set_user_relay_quota` / `get_user_relay_quota`（后者传数组则批量查询，结果在 `quotas`） |
| `getGlobalRelayQuota(url)` | `get_global_relay_quota` —— 服务器整体月度流量限额。响应 `quota` 含 `quotaBytes`(0=不限制)/`usedBytes`/`inboundBytes`/`outboundBytes`/`periodStartAt`/`periodResetDay`/`remainingBytes`/`unlimited`/`exceeded` |

## 五、关键实现细节

### 1. 握手挑战应答（server.js）

1. 连接 WebSocket 后等待服务端推送 `handshake_challenge`（含随机 challenge）。
2. 用本地私钥对 challenge 签名，回发签名。
3. 服务端验签通过后推送 `handshake` 成功事件（含 userId 等）。
4. 失败触发 `ws_error` 事件。

### 2. 自动重连（server.js）

- 默认关闭，通过 `setAutoReconnect({ enabled: true, baseDelay, maxDelay, multiplier, maxRetries })` 开启。
- 仅在**握手成功后的 `WebSocket.onclose`** 触发重连，握手阶段失败仍由 `connect()` 内部重试处理。
- 指数退避：第 `n` 次重连间隔为 `min(baseDelay * multiplier^(n-1), maxDelay)`。
- 同一 URL 的并发连接通过 `#connectPromises` 复用 Promise；`#reconnectTasks` 管理重连定时器，避免重复调度。
- 调用 `disconnect(url)` 会标记该 URL 为“用户主动断开”，清除待执行重连任务，关闭后不再自动重连。
- 显式调用 `connect(url)` 会解除“主动断开”标记并取消待执行重连。

### 3. 中继消息格式（user.js / server.js）

- **文本中继**：JSON 对象，含 `type`、`from`、`to`、`sessionId` 等字段。例如 `profile`、`rtc_signal`、`relay`、`__service_query`、`__service_response`、`update_services`。
- **二进制中继帧**：`[4B header_len BE][header JSON][payload]`，header 含路由信息。用于大 payload（如文件块），避免 JSON 序列化开销。

### 4. WebRTC 建链（rtc.js）

- 信令通道复用服务端中继：`rtc_signal` 消息携带 `{type:"offer"|"answer"|"ice", ...}`。
- **ICE 配置（可运行时变动）**：默认使用 Google 与 Cloudflare 公共 STUN 服务器（`stun.l.google.com:19302`、`stun.cloudflare.com:3478` 等）。支持 `setIceServers(servers)` 运行时替换配置（即时对新连接生效），`getIceServers()` 读取当前配置。构造时自动从 localStorage key `noneos:rtc:ice_servers` 读取用户自定义配置（由 `nos-tool/rtc-tool` 写入，仅取 `enabled !== false` 项）。对称型 NAT 等更严格环境仍需追加 TURN，否则降级为中继。
- DataChannel 名 `"noneos"`，`ordered: true`。
- 状态机：connecting → connected → failed/disconnected/closed；失败回退到中继。
- **Perfect Negotiation（glare 处理）**：每对 peer 维护 `polite` 标志（由 `this.#user.userId < otherUserId` 字典序比较决定，两侧互补）。双方同时发 offer（glare）时，`polite` 方 `setLocalDescription({type:"rollback"})` 回退自身 offer 并接受对方；`impolite` 方坚持自身 offer 并忽略对方。永不死锁。
- **ICE 候选缓冲**：每对 peer 维护 `pendingCandidates: []`。当 `pc.remoteDescription === null` 或 `signalingState === "have-local-offer"` 时收到的 ICE 候选先缓冲；`setRemoteDescription` 成功后 `#flushPendingCandidates` 依次 `addIceCandidate`，单条失败仅告警不中断。即使 ICE 早于 offer 到达，`#handleIce` 也会预建占位 peer 缓冲候选。
- **peer 写入时机**：`#handleOffer` / `#doConnect` 均在异步操作（`setRemoteDescription` / `createOffer`）之前写入 `#peers`，保证并发到达的 ICE 候选能立即查到 peer。
- **错误处理策略**：`handleSignal` 的 catch 仅在 PC 处于 `closed`/`failed` 时清理 peer；其他可恢复错误（乱序、状态错误）只记录告警，保留 peer 让后续信令继续推进。

### 5. E2EE 端到端加密

- 前置：通过 CredentialManager 交换双方个人资料（含经签名的公钥），校验 `publicKey → userId` 哈希一致 + 签名有效。
- 密钥派生：双方 `publicKey`/`privateKey` 做 ECDH（P-256）得到共享密钥。
- 加密：AES-GCM，每条消息含 IV/nonce + 密文 + TAG。
- `RemoteUser.send` 对普通对象自动加密；`raw=true` 跳过加密。

### 6. 凭证按 key 拉取协议（cred；cred.js，CredentialManager）

所有凭证（含个人资料）共用的按需拉取协议，线上类型 `type:"cred"`（raw 发送，不做 E2EE）：

```
A.requestRecord(fromUserId, key)          # key = {role, issuer, subject} 或 id 字符串
  ├── connectUser(fromUserId)             # 确保对端在线
  ├── findSessionId                       # 选一个会话
  ├── 发送 {type:"cred", action:"request", key} ──→ 对端
  │     （超时/发送失败 300ms 后自动重发 2 次，CRED_REQ_RETRIES）
  └── 对端回 {type:"cred", action:"response", key, data} ──→ A
        ├── data 非空：校验记录与 key 一致 + 统一验签 → importRecord（signTime 竞争收敛）
        │     ├── role="profile" → 触发 profile_received，并校验 subject === 发送方
        │     └── 其他 role → 触发 cert_received
        └── data 为 null（对端无该记录）→ resolve(null)
```

**应答规则**：不限定签发/被签发关系——响应方对本地持有的任意精确匹配 key 的记录都应答（含他人签发给第三方的证书，支持本地应用托管此类记录）。安全边界：请求方必须已知精确 key（无法枚举），且收到记录仍走 `importRecord` 完整验签。注意：本地用户**自己的** profile 存于 data store（`saveUserInfo`，key `"info"`）而非 certs store，应答时命中本地 profile key 走 `getInfo()` 读取。

**个人资料（profile）= role="profile" 的自签证书**：`updateInfo()` 产出的用户信息即资料签名载荷，形态为 `{role:"profile", issuer, subject, username..., signTime, publicKey, signature}`（`subject` 标识持有者）。`getProfile`/`requestProfile`/`getProfileByDB` 是通用拉取的薄封装（key 固定为 `{role:"profile", issuer:uid, subject:uid}`，向持有者本人拉取，并保留 subject === 发送方校验）。

可靠性：拉取是幂等 RPC——接收端按 `signTime` 保留更新的记录，重复请求与迟到响应均安全，因此超时（`CRED_REQ_TIMEOUT = 10s`）或发送阶段异常直接重发；`#requestMap` 按 `fromUserId+key` 合并并发请求，重试耗尽才 reject。资料的 signTime 仅作版本号，收敛时不做未来时间校验（区别于授权类证书）。

**纯拉取、无推送**：`updateInfo` / `issue` 成功后只写本地，不向任何对端广播。凭证变更由对端按需拉取（`getRecord` 缓存优先 / `requestRecord` 强制网络），拉取后经 signTime 竞争自动收敛到最新版本，无需额外协调。

### 7. 服务注册与发现（service-registry.js + remote-user.js）

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

### 8. IndexedDB Schema（db.js）

- 数据库名：`nos_user_${namespace}`，`DB_VERSION = 8`
- 四仓库：
  - `data`：用户信息、密钥、服务器列表等键值。**含 `user-storages` 键**：字符串数组，登记该用户通过 `LocalUser.getStorage()` 创建的全部存储 id（`addUserStorageId` 去重追加 / `getUserStorageIds` 读取），供 `deleteUser` 联动清理。**含 `shared-storages` 键**：字符串数组，登记该用户通过 `LocalUser.shareStorage()` 显式开放的共享空间名（`addSharedStorage` / `removeSharedStorage` / `getSharedStorages`），供入站共享请求做「已显式开启」校验
  - `certs`：keyPath `"id"`，7 个索引（role/issuer/subject 及 4 个复合索引）。**统一凭证库**：既存授权证书，也存个人资料（`role="profile"`、`issuer=subject=userId` 的自签记录，id = `profile-${userId}-${userId}`）；`saveCertIfNewer` 在同一事务内按 signTime 竞争写入（原子化，防并发导入竞态）；索引选择统一走 `pickCertIndex`（按 role/issuer/subject 组合选最优索引）。**keyset 分页**：`getCertsPage(namespace, query, {limit, after, filter})` 用游标按 `[索引键, 主键]` 顺序读取，返回 `{items, nextCursor, hasMore}`（凑满 limit 后多探测一条判定 hasMore）；`after` 传上页 `nextCursor` 续读——**索引路径 range 始终 `only(indexKey)`，同键内主键 ≤ token 主键的记录在游标循环中跳过**（IDB 索引游标的 range 只作用于索引键、无主键 tie-break，数组下界会因"数组恒大于标量"排除全部目标键），无索引路径按主键标量排他下界；`filter` 拒绝的记录不占 limit 额度（配合过期过滤页面不缩水）
  - `traffic_entries`：keyPath `"id"`（自增），流量明细，索引 `ts / peer_ts / dir_ts / cat_ts / app_ts / server_ts`
  - `traffic_agg_minute`：keyPath `"id"` = `"${bucket}|${peerUserId}|${via}|${serverUrl}|${category}"`，分钟聚合桶；索引 `bucket`/`peer_bucket`/`via_bucket`/`server_bucket`/`cat_bucket`（供 summary 聚合查询）
- 连接缓存 5s 自动关闭，避免长期占用。
- **v7→v8 迁移**：删除 cards store，旧缓存资料**不做搬迁**——其签名只覆盖旧字段集，补入统一存储所需字段后无法通过验签，也无法用他人私钥重签；资料是可再生的拉取缓存，删除后按需重取自愈。

### 9. 流量记录（traffic.js）

- **埋点位置**：入站在 [user.js #setupRelayDispatch / #setupRTCDispatch](./user.js)；出站在 [server.js sendToServer](./server.js)（含握手响应）+ [remote-user.js RTC 分支](./remote-user.js)。
- **记录内容**：仅元数据 + 链路字节数（`size`），从不记录消息内容。
- **字段**：`ts / direction / peerUserId / sessionId / via / serverUrl / size / category / messageType / appId / success / errorCode`。
- **category 枚举**：`app / service / profile / rtc_signal / handshake / latency / control / relay / other`。
- **失败记录**：`success: false`，`size` 为尝试发送字节，`errorCode` 记原因（如 `not_open`）。
- **批量刷盘**：默认 500ms 或积累 50 条触发；`deleteBefore`/`delete` 之前会 `flush()`；**`clearAll()` 则直接丢弃未刷盘队列**（不调用 flush）。
- **聚合桶**：`peerUserId × via × serverUrl × category`，按分钟对齐。**不含 appId 维度**，按 app 查询走明细表 `by_app_ts` 索引。
- **主要 API**：`record / flush / query / summary / getPeerTotals / getServerTotals / getTimeline / getTotalStats / count / getStorageInfo / deleteBefore / delete / clearAll / setEnabled / configure`。
- **数据保留**：默认永久保留，通过 `deleteBefore(ts)` / `delete(filter)` / `clearAll()` 由上层清理应用管理。

### 10. 远端共享存储协议（__storage_req / __storage_resp）

接收端在 `#dispatchToRemote` 中拦截 `type === "__storage_req"` 的入站消息（user.js `#handleStorageRequest`），按三道防线校验后以只读方式本地执行，结果经 `__storage_resp` 回传（`raw=true` 跳过 E2EE，与 `__service_response` 一致）：

```
远端 ──→ { type:"__storage_req", reqId, name, op, key }
本地 ──→ { type:"__storage_resp", reqId, ok:true, value }          # 成功
      └→ { type:"__storage_resp", reqId, ok:false, error:{code, message} }  # 失败
```

**三道防线**（依次校验，任一失败即回传错误）：

| 防线 | 校验 | 失败错误码 |
|------|------|-----------|
| 1. 约定前缀 | `name` 必须以 `"share:"` 开头 | `invalid_name` |
| 2. 显式开启 | `name` 必须在 `shared-storages` 登记表（已 `shareStorage()`） | `not_shared` |
| 3. 只读白名单 | `op` 仅允许 `getItem / has / key / length / keys / entries` | `read_only` |

**错误码**：`invalid_name`（非 share: 前缀）/ `not_shared`（未显式开启或已 revoke）/ `read_only`（含 setItem/removeItem/clear 等写操作与未知 op）/ `too_large`（响应超过中继单条消息 256KB 硬限制，无法送达；接收端在回传前用 `TextEncoder` 测量完整 resp 的 `JSON.stringify` 字节数，超限（`SHARED_STORAGE_RESP_MAX_BYTES = 256 * 1024`）即改回此错误，避免请求端干等超时）/ `internal`（登记表读取失败、操作执行异常等）。

**执行细节**：`length` 是 getter（`await storage.length`）；`keys / entries` 是异步生成器，收集为数组后回传；`getItem` 对不存在的 key 返回 `ok:true, value:null`；所有已连接用户均可发起请求（无白名单），安全边界完全由上述三道防线构成。

**请求端**（remote-user.js `getStorage` / `#requestStorage`）：调用前本地预校验 `share:` 前缀；`getSessionIds()` 为空直接抛 `code:"offline"`（确定状态，不重试）；`sendToUser` 投递失败（候选 session 过期、服务器确认目标不在线）抛出的 Error 也带 `code:"offline"`，不会被当作瞬时错误重试；`#sendRaw` 发送请求（raw，与 `__service_query` 一致）后按 reqId 挂起等待，单次尝试超时抛 `code:"timeout"`（默认 10s，`getStorage(name, { timeout })` 可调）。**自动重发**：只读操作幂等，对瞬时失败（超时、无 code 的发送异常）默认重发 1 次（`retries` 选项可调，每次尝试用新 reqId）；对端明确回传的错误（`not_shared` 等）为确定性失败，立即抛出不重试。`__storage_resp` 由 `#setupPingListener` 拦截并按 reqId 结算，对端错误回传时抛出带 `code` 的 Error。

### 11. （已移除）凭证互传 __cert_share

已删除：凭证交付统一走第 6 节的按 key 拉取协议（`cred.requestRecord`）。`RemoteUser.shareCert` 与 `__cert_share` 消息不再存在；拉取导入成功触发 `cert_received`（detail 与原 `__cert_share` 路径一致）。**信任边界**：接收端只验记录的密码学有效性，不判断 issuer 是否可信——「谁签发的证书算数」是应用层在 `query/has` 消费时的语义。

## 六、客户端-服务端联动协议对应表

| 客户端行为 | 传输 | 消息类型 | 服务端处理（见 server/handshake/CONTEXT.md） |
|-----------|------|---------|----------------------------------------|
| 握手应答 | WS 文本 | `handshake_challenge` → 签名回发 | `handle_connection` 验签注册 |
| 中继发送 | WS 文本/二进制 | `relay` JSON / 二进制帧 | `relay` 分支 + `relay_deliver_and_finalize` |
| RTC 信令 | 中继 | `rtc_signal` (offer/answer/ice) | 透传中继 |
| 凭证按 key 拉取 | 中继 | `cred` (request/response，raw 不做 E2EE) | 透传中继 |
| 服务发现 | 中继 | `__service_query`/`__service_response`/`__service_available`/`__service_unavailable` | 透传中继 |
| 共享存储读取 | 中继 | `__storage_req`/`__storage_resp`（只读） | 透传中继 |
| 凭证互传 | —— | 已移除，统一走 `cred` 按 key 拉取 | —— |
| 服务上报 | WS 文本 | `update_services` | `update_services` 分支，存入 UserSession.services |
| 应用消息 | 中继 | `__app`/`__data` 包裹 | 透传中继 |
| 延迟测速 | WS 文本 | `latency_test` → `latency_test_response` → `latency_report` | `latency_test`/`latency_report` 分支 |
| 管理命令 | HTTP | `/admin?...` | AdminCommand 路由（见 admin.rs） |
| 心跳 | WS Ping | —— | 服务端 15s Ping / 60s 超时 |

## 七、依赖关系

- `../util/hash/get-hash.js` —— userId 派生
- `../crypto/crypto-ecdsa.js` —— ECDSA 签名/验签（base-user.js、cred.js、user.js）
- `../crypto/crypto-e2ee.js` —— E2EE 加解密（remote-user.js；user.js 动态导入）
- `../crypto/crypto-aes.js` —— AES 加解密（main.js，用于 export/import 加密）
- `../storage/main.js` —— `LocalUser.getStorage()` 用户专属存储（user.js / main.js 静态导入；storage 无静态依赖，不成环）
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
| `profile_received` | 收到对端个人资料（请求响应）。detail: `{ userId, profile, saved }` |
| `cert_received` | 按 key 拉取到非 profile 凭证并验证入库（cred 协议）。detail: `{ cert, saved, fromUserId }`，`saved=false` 表示本地已有更新的同 id 记录 |
| `remote_user_connected` | RemoteUser 进入缓存：主动 `connectUser()` 成功，或收到对方消息后被动创建。detail: `{ userId, remoteUser, initiatedBy: "local"|"remote" }` |
| `remote_user_disconnected` | RemoteUser 被移除：显式 `disconnectUser()`（`reason: "manual"`），或 `connectUser()` 失败（`reason: "error"`）。detail: `{ userId, remoteUser, reason, error }` |
| `service_registered` / `service_unregistered` | 本地 `ServiceRegistry.register`/`unregister` 成功时触发。detail: `{ appId }` |
| `unhandled_service_message` | 收到 `__app` 消息但本地未注册该 `appId`（含显式 sessionId 定投或对端缓存未刷新）。detail: `{ appId, fromUserId, fromSessionId, data }` |
