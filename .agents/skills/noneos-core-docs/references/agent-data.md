# 通过服务器代理数据通信

任意用户可以通过信令服务器查询其他用户的在线状态，并通过服务器转发数据。

## 查询用户在线状态

```javascript
const result = await user.server.queryUserOnline(url, targetUserId);
// 返回：{ online: true/false, sessions: ["s-xxxx", ...], sessionInfo: [{ sessionId, latencyMs }, ...] }
```

### 查询自己

```javascript
const selfStatus = await user.server.queryUserOnline(url, user.userId);
console.log(selfStatus.online);   // true
console.log(selfStatus.sessions); // 包含自己的 sessionId
```

### 查询离线用户

```javascript
const offlineStatus = await user.server.queryUserOnline(url, "non-existent-user");
console.log(offlineStatus.online);    // false
console.log(offlineStatus.sessions);  // []
```

### 查询其他在线用户

```javascript
const otherStatus = await userA.server.queryUserOnline(url, userB.userId);
console.log(otherStatus.online);    // true
console.log(otherStatus.sessions);  // 包含 userB 的 sessionId
```

## 通过服务器转发数据

### 转发到指定用户 Session

```javascript
const result = await user.server.relayToUserViaServer(
  url,
  targetUserId,
  targetSessionId,
  { text: "Hello", number: 42 }
);

console.log(result.status); // "ok"
```

### 目标用户接收数据

目标用户通过 `message` 事件接收：

```javascript
user.bind("message", (event) => {
  let data = typeof event.detail.data === "string"
    ? JSON.parse(event.detail.data)
    : event.detail.data;

  if (data.type === "relay" && data.from_user_id === senderUserId) {
    console.log("收到数据:", data.data);  // { text: "Hello", number: 42 }
  }
});
```

## 自动选择服务器转发

如果用户连接了多台服务器，可使用 `sendToUser` 自动选择合适的中继：

```javascript
const result = await user.server.sendToUser(
  targetUserId,
  targetSessionId,
  payload
);
```

### 目标离线

目标用户不在线时抛出错误：

```javascript
try {
  await user.server.sendToUser("offline-user", "session-id", { data: true });
} catch (error) {
  // 错误：目标不在线
  // error.code === "offline"（确定状态，调用方无需重试）
}
```

### 无可用连接

本地没有连接任何服务器时抛出错误：

```javascript
try {
  await user.server.sendToUser("target", "session", { data: true });
} catch (error) {
  // error.message 包含 "No connected servers"
}
```

## 二进制数据传输

支持通过服务器转发二进制数据（Uint8Array、ArrayBuffer）：

```javascript
// 发送 Uint8Array
const bytes = new Uint8Array(256);
for (let i = 0; i < 256; i++) bytes[i] = i;

const result = await user.server.relayToUserViaServer(url, targetUserId, sessionId, bytes);

// 发送 ArrayBuffer
const buffer = new Uint8Array([0, 1, 2, 255, 254]).buffer;
await user.server.relayToUserViaServer(url, targetUserId, sessionId, buffer);
```

二进制数据的帧格式：
- 4 字节 header 长度（u32 BE）
- header JSON（含 `type`、`from_user_id`、`from_session_id`）
- payload 原始字节
