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
