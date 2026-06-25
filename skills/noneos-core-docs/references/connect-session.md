# Session 管理

## Session 下线通知

当对方的某个 session 离开时（如关闭标签页、断开所有服务器连接），会触发 `session_left` 事件：

```javascript
const remote = await userA.connectUser(userB.userId);

remote.bind("session_left", (event) => {
  console.log(event.detail.sessionId); // 离开的 session ID
});

// userB 断开所有服务器连接 → 触发 session_left
userB.server.disconnectAll();
```

## 部分服务器断开不触发 Session Left

如果用户连接了多台服务器，仅断开一台不会触发 `session_left`：

```javascript
// userB 连接了两台服务器
await userB.server.connect("ws://localhost:8081");
await userB.server.connect("ws://localhost:8082");

// 只断开一台 → 不会触发 session_left
userB.server.disconnect("ws://localhost:8081");
```

## RTC 连接后服务器断开不触发 Session Left

当双方已建立 WebRTC 连接后，即便断开所有服务器连接也不会触发 `session_left`：

```javascript
// 多次 send 触发后台 RTC 配对
for (let i = 0; i < 5; i++) {
  await remote.send(userP.sessionId, { ping: i });
  await new Promise(r => setTimeout(r, 300));
}

// RTC 连接建立后，断开所有服务器
userP.server.disconnectAll();

// session_left 不会被触发（RTC 连接仍存活）
```
