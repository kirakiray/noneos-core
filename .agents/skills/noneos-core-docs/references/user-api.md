# NoneOS Core 用户管理 API 参考

LocalUser 是 NoneOS Core 的用户管理模块，提供基于 ECDSA 的密钥管理、数据签名验证和证书管理功能。

## 个人信息管理

### 更新与获取

```javascript
const user = await getUser("my-user");

// 更新信息（自动签名并存储）
const info = await user.updateInfo({
  nickname: "我的昵称",
  email: "user@example.com"
});

// 获取已保存的信息
const userInfo = await user.getInfo();
```

## 证书管理

### 签发与导入

```javascript
const admin = await getUser("admin-user");
const normalUser = await getUser("normal-user");

// 管理员签发证书（expire 不传默认 30 天后过期，传 null 永不过期）
const cert = await admin.cred.issue({
  subject: normalUser.userId,
  role: "editor"
});

// 用户导入证书
await normalUser.cred.import(cert);
```

### 查询与删除

```javascript
// 查询
const editorCerts = await user.cred.query({ role: "editor" });

// 分页查询（keyset）：返回 { items, nextCursor, hasMore }，after 续读下一页
const page = await user.cred.query({ role: "editor" }, { limit: 50 });

// 检查
const hasEditorRole = await user.cred.has({ role: "editor" });

// 删除
await user.cred.delete(cert.id);
```

## 远程用户高级功能

### 延迟测量

```javascript
const rtt = await remoteUser.ping(sessionIds[0]);
```

### 服务器管理

```javascript
// 连接指定服务器（第二个参数可传数字重试次数，也可传 { retries } 选项）
await user.server.connect("ws://localhost:8081");

// 配置自动重连
user.server.setAutoReconnect({
  enabled: true,
  baseDelay: 2000,
  maxDelay: 30000,
  multiplier: 2,
  maxRetries: Infinity,
});

// 手动断开指定服务器，并停止该 URL 的自动重连
user.server.disconnect("ws://localhost:8081");

// 获取服务器列表
const servers = await user.server.getServers();
```

## 生命周期管理

### 导出用户

```javascript
import { exportUser } from "/nos/user/main.js";
const encrypted = await exportUser("my-namespace", "password");
```

### 导入用户

```javascript
import { importUser } from "/nos/user/main.js";
const user = await importUser("new-namespace", encrypted, "password");
```

### 删除用户

```javascript
import { deleteUser } from "/nos/user/main.js";
await deleteUser("my-namespace", { skipConfirm: true });
```

---

## API 详细定义

### LocalUser 类

| 属性/方法 | 说明 |
|-----------|------|
| `userId` | 用户唯一标识（公钥哈希） |
| `publicKey` | 用户公钥 |
| `sign(data)` | 对数据进行签名 |
| `verify(signedData)` | 验证数据签名 |
| `ready()` | 准备用户实例 |
| `connectUser(userId)` | 连接远程用户，成功触发 `remote_user_connected` |
| `disconnectUser(userId)` | 断开远程用户，触发 `remote_user_disconnected`（`reason: "manual"`） |
| `remoteUsers` | 只读 getter，返回已缓存的 `RemoteUser[]` |
| `isRemoteUserOnline(userId)` | 查询指定 userId 当前是否在线 |
| `getRemoteUsers({ onlineOnly })` | 获取已缓存的 `RemoteUser[]`，`onlineOnly: true` 时过滤在线用户 |
| `getSessionIds(timeout?)` | 获取同一 namespace 下所有标签页的 sessionId |
| `getStorage(name)` | 获取该用户专属的独立存储空间（async），复用 `nos/storage`，存储 id = `user:<namespace>:<userId>:<name>`，不同用户/身份互不可见；`deleteUser` 时联动清理 |
| `shareStorage(name)` | 显式开启一个存储空间的共享（**只读**，async）。`name` 必须以 `share:` 开头，否则抛错；返回 revoke 函数可随时关闭共享；重复开启幂等 |
| `traffic` | 流量记录器（`TrafficLogger`），详见 [客户端流量统计](traffic.md) |

#### LocalUser 事件

| 事件 | 说明 |
|------|------|
| `remote_user_connected` | `connectUser()` 成功或收到对方消息后创建 RemoteUser。detail: `{ userId, remoteUser, initiatedBy }` |
| `remote_user_disconnected` | `disconnectUser()` 或 `connectUser()` 失败。detail: `{ userId, remoteUser, reason, error }` |
| `message` | 通过服务器中继收到消息 |
| `rtt_update` | RTT 延迟更新 |
| `profile_received` | 收到个人资料（请求响应） |
| `cert_received` | 按 key 拉取到非 profile 凭证并验证入库（cred 协议）。detail: `{ cert, saved, fromUserId }` |

### RemoteUser 类

`localUser.connectUser(userId)` 返回的远端用户实例。

| 方法 | 说明 |
|------|------|
| `userId` | 只读 getter，目标用户 ID |
| `getSessionIds()` | 查询对方当前所有 sessionId |
| `send(sessionId, data, raw?)` | 发送消息（RTC 优先/服务端中继，对象默认 E2EE） |
| `ping(sessionId, timeout?)` | 测 RTT |
| `getRTT(sessionId?)` | 读缓存的 RTT |
| `sendToService(appId, data, options?)` | 应用间通信（服务发现精准投递） |
| `getStorage(name, options?)` | 获取对方**显式共享**的存储空间只读代理（async）。`name` 必须 `share:` 开头（本地预校验抛错）；同一 `(userId, name)` 代理缓存复用。代理：`getItem/has/key/length/keys/entries`（走 `__storage_req`，单次尝试默认 10s 超时 `options.timeout` 可调；瞬时失败自动重发，默认 `options.retries=1`），`setItem/removeItem/clear` 调用即抛错；失败 Error 带 `code`（`offline/timeout/invalid_name/not_shared/read_only/too_large/internal`） |

> 凭证交付走拉取而非推送：用 `cred.requestRecord` / `cred.getRecord`（见下表）向对方按 key 拉取证书或资料，`shareCert` 已移除。

### CredentialManager 类 (user.cred)

个人资料（profile）与证书的统一凭证管理器。

| 方法 | 说明 |
|------|------|
| `issue(options)` | 签发证书 |
| `import(certData)` | 导入并验证证书 |
| `importRecord(certData)` | 同 `import`，但返回 `{ cert, saved }`（saved 表示是否实际写入） |
| `query(query)` | 查询凭证（含个人资料记录） |
| `has(query)` | 检查是否拥有某凭证 |
| `delete(id)` | 按记录 id 删除证书记录 |
| `deleteProfile(userId)` | 删除某用户的个人资料记录 |
| `count(query)` | 获取数量；无查询条件时含资料在内的全部记录 |
| `values(query)` | 异步迭代器；无查询条件时含资料在内的全部记录 |
| `getRecord(fromUserId, keyOrId)` | 按需获取凭证记录：DB 优先 → 向指定用户按 key 网络拉取（10s 超时自动重发 2 次）；未命中返回 `null` |
| `getRecordByDB(keyOrId)` | 从本地按 key 读凭证记录（签名载荷视图，可整体验签） |
| `requestRecord(fromUserId, keyOrId)` | 强制网络拉取凭证记录（key 为 `{role, issuer, subject}` 或 id 字符串）；未命中 `resolve(null)` |
| `getProfile(userId)` | 获取个人资料：DB 优先 → 网络拉取（`getRecord` 薄封装，key 固定 `{role:"profile", issuer:uid, subject:uid}`） |
| `getProfileByDB(userId)` | 直接读本地资料（签名载荷视图，可整体验签） |
| `requestProfile(userId)` | 强制网络刷新资料（`requestRecord` 薄封装） |

> 个人资料是 `role="profile"` 的自签证书记录（`issuer === subject`），可用同一套查询 API 访问（如 `cred.query({ role: "profile", subject })`）。`role="profile"` 为系统保留角色，仅允许自签，不构成授权。
