# 用户连接与通信

## 连接远程用户

```javascript
import { LocalUser } from "/nos/user/user.js";

const userA = new LocalUser("user-a");
const userB = new LocalUser("user-b");
await Promise.all([userA.ready(), userB.ready()]);

// 双方连接到同一台服务器
await Promise.all([
  userA.server.connect("ws://localhost:8081"),
  userB.server.connect("ws://localhost:8081"),
]);

// userA 连接 userB
const remoteB = await userA.connectUser(userB.userId);
```

## 获取已连接的远程用户

LocalUser 会缓存所有已经建立通信的 `RemoteUser` 实例，并暴露为只读数组：

```javascript
// 当前已缓存的 RemoteUser 列表（主动 connectUser + 被动收到消息后自动创建）
const list = userA.remoteUsers;
list.forEach((remoteUser) => {
  console.log(remoteUser.userId);
});
```

## 断开远程用户

```javascript
await userA.disconnectUser(userB.userId);
// 清理本地缓存并触发 remote_user_disconnected（reason: "manual"）
```

## 监听连接状态变化

```javascript
userA.bind("remote_user_connected", (event) => {
  const { userId, remoteUser, initiatedBy } = event.detail;
  // initiatedBy: "local" 表示我主动 connectUser 成功
  // initiatedBy: "remote" 表示对方发消息给我，core 被动创建了 RemoteUser
});

userA.bind("remote_user_disconnected", (event) => {
  const { userId, remoteUser, reason, error } = event.detail;
  // reason: "manual" 表示主动 disconnectUser
  // reason: "error"  表示 connectUser 失败
});
```

## 查询在线状态

```javascript
// 单个用户是否在线
const online = await userA.isRemoteUserOnline(userB.userId);

// 一次性过滤出当前在线的远程用户
const onlineUsers = await userA.getRemoteUsers({ onlineOnly: true });
```

## 发现用户 Session

同一个用户可以有多台设备/标签页，每个标签页是一个独立 session：

```javascript
const sessionIds = await remoteB.getSessionIds();
// 返回 userB 所有在线的 sessionId 列表
```

## 应用服务通信（sendToService）

`sendToService` 用于向对端**注册了指定 `appId` 的所有 session** 发送消息，底层自动完成服务发现、精准投递与失败反馈。

### 注册服务

```javascript
const svc = userB.registerService("chat-v1", {
  onMessage(data, ctx) {
    // ctx: { fromUserId, fromSessionId, remoteUser }
    console.log("收到消息：", data);
    // 可通过 ctx.remoteUser.send / sendToService 回复
  },
});
// 之后可通过 svc.unregister() 注销
```

注册/注销时会自动向 `remoteUsers` 广播 `__service_available` / `__service_unavailable`，让对端立即刷新服务缓存。

### 精准投递（默认）

```javascript
const results = await remoteB.sendToService("chat-v1", { text: "hi" });
```

底层步骤：
1. 命中 `serviceSessionCache`（TTL 30s，或对端主动推送刷新）→ 直接投递
2. 未命中缓存 → 查询对端所有 session，再发起 `__service_query` 询问归属并写入缓存
3. 只发到装了 `chat-v1` 的 session，不再盲广播

### 返回值语义

`sendToService` 不会抛异常，通过返回数组的 `status` 字段表达结果：

| status | 含义 |
|---|---|
| `"ok"` + `delivered:true` | 成功送达（含 `sessionId` / `via`） |
| `"no_receiver"` | 对端在线，但没有 session 注册该 `appId` |
| `"offline"` | 对端所有 session 都不在线 |
| `"discovery_failed"` | 服务发现流程超时（可用 `fallback:"broadcast"` 兜底） |
| `"error"` | 底层 `send` 失败（如 session 中途离线） |

```javascript
const results = await remoteB.sendToService("chat-v1", data);
const delivered = results.some((r) => r.status === "ok");
if (!delivered) {
  console.warn("消息未送达：", results[0]?.status);
}
```

### 等待对端上线服务

对端可能尚未 `registerService`，可通过 `waitForService` 挂起等待：

```javascript
const results = await remoteB.sendToService(
  "chat-v1",
  { text: "hello" },
  { waitForService: 3000 }, // 最多等 3 秒对端上线
);
// 期间对端一旦 registerService，会通过 __service_available 通知，立即精准投递
```

超时仍未上线则返回 `no_receiver`。

### 定向发送到指定 session

指定 `sessionId` 时不做服务发现，直接透传：

```javascript
await remoteB.sendToService("chat-v1", data, {
  sessionId: ctx.fromSessionId, // 定向回复某个 session
});
```

若目标 session 未注册该 `appId`，接收方会触发 `unhandled_service_message` 事件而非静默丢弃。

### 兜底广播

服务发现失败或需要向对端所有 session 广播时：

```javascript
await remoteB.sendToService("chat-v1", data, {
  fallback: "broadcast",
});
```

### 未处理消息事件

接收端收到 `__app` 消息但未注册该 `appId` 时，会在 `LocalUser` 上触发 `unhandled_service_message` 事件：

```javascript
userB.bind("unhandled_service_message", (event) => {
  const { appId, fromUserId, fromSessionId, data } = event.detail;
  console.warn("收到未注册应用的消息：", appId);
});
```

可用于调试、兜底路由或应用启动窗口的补偿处理。

### 服务注册状态事件

本地 `registerService` / `unregister` 成功时会触发事件：

```javascript
userB.bind("service_registered", (e) => {
  console.log("已注册服务：", e.detail.appId);
});
userB.bind("service_unregistered", (e) => {
  console.log("已注销服务：", e.detail.appId);
});
```

## 发送消息

### 发送文本/JSON 数据

```javascript
await remoteB.send(userB.sessionId, "hello");           // 字符串
await remoteB.send(userB.sessionId, { text: "hi" });    // 对象
```

### 发送二进制数据

```javascript
const binaryData = new Uint8Array([0x00, 0x01, 0x02, 0xff]);
await remoteB.send(userB.sessionId, binaryData);
```

二进制数据通过 WebSocket 以帧格式传输：
- 4 字节 header 长度（u32 BE）
- header JSON（包含 `from_user_id`、`from_session_id` 等）
- payload 数据

## 接收消息

通过 `bind("message", handler)` 监听消息：

### 本地用户监听

```javascript
userA.bind("message", (event) => {
  const raw = event.detail.data;
  // raw 可能是字符串或 Blob（二进制）
  console.log(event.detail.fromUserId);
  console.log(event.detail.fromSessionId);
  console.log(event.detail.url);      // 中继服务器 URL
});
```

### RemoteUser 监听

```javascript
remoteB.bind("message", (event) => {
  console.log(event.detail.fromUserId);
  console.log(event.detail.fromSessionId);
  console.log(event.detail.data);
});
```

## 名片交换

名片（Card）是用于身份验证和 E2EE 加密的凭证，包含用户的公钥和签名信息。

### 获取对方名片

```javascript
const card = await userA.card.get(userB.userId);
// 返回名片对象，包含 userId、publicKey、username、signTime、signature

// 验证名片签名
const valid = await userB.verify(card);
```

### 名片缓存

获取后名片会自动缓存到本地数据库，再次获取直接返回缓存：

```javascript
const cached = await userA.card.get(userB.userId);   // 从缓存返回
const fromDb = await userA.card.getByDB(userB.userId); // 直接从 DB 读取
```

### 删除名片

```javascript
await userA.card.delete(userB.userId);
```

### 名片事件

当收到对方的名片时，会触发 `card_received` 事件：

```javascript
userA.bind("card_received", (event) => {
  console.log(event.detail.userId);     // 名片所属用户
  console.log(event.detail.saved);      // 是否已保存到数据库
});
```

## E2EE 加密通信

当双方都持有对方的名片（公钥）后，发送的对象数据会自动加密：

```javascript
// 确保双方已交换名片
const cardB = await userA.card.get(userB.userId);
const cardA = await userB.card.get(userA.userId);

// 发送加密消息：纯对象会自动触发 E2EE 加密路径
await remoteJ.send(userJ.sessionId, { text: "hello encrypted", num: 42 });

// 接收端自动解密，收到的数据是解密后的明文
```

加密特征：原始 relay 数据为二进制帧（Blob），而非 JSON 字符串。

## RTT 延迟测量

### 单次 Ping

```javascript
const rtt = await remoteB.ping(userB.sessionId);
console.log(rtt); // RTT 值 (ms)
```

### 获取测量结果

```javascript
// 按 session 获取
const rttInfo = remoteB.getRTT(userB.sessionId);
console.log(rttInfo.rtt);   // RTT 值
console.log(rttInfo.via);   // 传输方式: "server" 或 "rtc"
console.log(rttInfo.url);   // 服务器 URL（via 为 "server" 时）

// 获取最佳 RTT
const best = remoteB.getRTT();
console.log(best.rtt);
console.log(best.via);

// 未测量过的 session 返回 null
const unknown = remoteB.getRTT("nonexistent-session");
console.log(unknown); // null
```

### RTT 更新事件

```javascript
userA.bind("rtt_update", (event) => {
  console.log(event.detail.userId);     // 目标用户
  console.log(event.detail.sessionId);  // 目标 session
  console.log(event.detail.rtt);        // RTT 值
  console.log(event.detail.via);        // 传输方式
});
```
