# 服务器连接与握手

## 连接服务器

```javascript
import { LocalUser } from "/nos/user/user.js";

const user = new LocalUser("my-ns");
await user.ready();

const result = await user.server.connect("ws://localhost:8081");
console.log(result.success);  // true
console.log(result.version);  // 服务器版本号字符串
```

## 握手流程

连接时，`server.connect()` 内部自动完成握手流程：
1. 客户端发起 WebSocket 连接
2. 服务器发送 `handshake_challenge`
3. 客户端用私钥签名 challenge 等信息，返回 `handshake_response`
4. 服务器验证签名，验证通过后返回成功

## WebSocket 复用

对同一 URL 多次调用 `connect()` 会复用已有连接：

```javascript
const r1 = await user.server.connect("ws://localhost:8081"); // 首次连接
const r2 = await user.server.connect("ws://localhost:8081"); // 复用缓存
console.log(r1.success === r2.success); // true
```

## 安全特性

### 篡改数据检测

服务器会验证客户端签名的 userInfo，篡改数据会被拒绝：

```javascript
// 篡改后的握手请求会收到 "Verification failed" 错误
```

### 篡改签名检测

修改签名内容后，服务器验证失败：

```javascript
// 修改签名字符串后握手会失败
```

### 握手超时

客户端不响应 challenge，服务器会超时断开：

```javascript
// 服务器在超时后关闭连接，返回 timeout 错误
```

## 延迟测量

### 单次延迟测试

```javascript
const result = await user.server.testLatency("ws://localhost:8081");
console.log(result.rtt);            // 往返时间 (ms)
console.log(result.oneWayLatency);  // 单向延迟 (ms)
```

### 周期性延迟监测

```javascript
// 启动监测（每 100ms 测一次，调试用短间隔）
user.server.startLatencyMonitor(100);

// 监听延迟事件
user.bind("latency_test", (event) => {
  console.log(event.detail.rtt);          // 往返时间
  console.log(event.detail.oneWayLatency); // 单向延迟
  console.log(event.detail.url);           // 服务器 URL
});

// 停止监测
user.server.stopLatencyMonitor();
```

## 获取连接状态

```javascript
const connectedUrls = user.server.connectedUrls; // 已连接的服务器列表
```
