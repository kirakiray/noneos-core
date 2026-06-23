# LocalUser - 本地用户管理

LocalUser 是 NoneOS Core 的用户管理模块，提供基于 ECDSA 的密钥管理、数据签名验证和证书管理功能。

## 安装

确保已安装 NoneOS Core，参考 [NoneOS Core 安装文档](https://core.noneos.com)。

## 引入

```javascript
import { getUser } from "/nos/user/main.js";
```

## 基本用法

### 获取用户实例

```javascript
const user = await getUser("my-namespace");

console.log(user.userId);     // 用户唯一标识（公钥哈希）
console.log(user.publicKey);  // 用户公钥
console.log(user.namespace);  // "my-namespace"
```

`getUser` 会自动创建或获取已缓存的用户实例，并调用 `ready()` 准备用户。多次调用相同命名空间会返回同一个实例：

```javascript
const user1 = await getUser("app-user");
const user2 = await getUser("app-user");
console.log(user1 === user2); // true
```

### 数据签名与验证

```javascript
const user = await getUser("signer");

// 签名数据
const data = { message: "Hello, World!", timestamp: Date.now() };
const signedData = await user.sign(data);

// 验证签名
const isValid = await user.verify(signedData);
console.log(isValid); // true

// 篡改数据后验证失败
const tampered = { ...signedData, message: "Tampered!" };
console.log(await user.verify(tampered)); // false
```

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
console.log(userInfo.username);  // 默认用户名 "user-xxxxx"
console.log(userInfo.nickname);  // "我的昵称"
```

### 信息合并更新

多次调用 `updateInfo` 会合并数据，不会覆盖未更新的字段：

```javascript
await user.updateInfo({ nickname: "初始昵称", city: "北京" });
await user.updateInfo({ nickname: "新昵称", hobby: "编程" });

const info = await user.getInfo();
console.log(info.nickname); // "新昵称"
console.log(info.city);     // "北京"（保留）
console.log(info.hobby);    // "编程"（新增）
```

### 验证信息签名

```javascript
const info = await user.getInfo();
const isValid = await user.verify(info);
console.log(isValid); // true
```

## 证书管理

### 签发与导入

```javascript
const admin = await getUser("admin-user");
const normalUser = await getUser("normal-user");

// 管理员签发证书
const cert = await admin.cert.issue({
  subject: normalUser.userId,
  role: "editor",
  permissions: ["read", "write"]
});

// 用户导入证书（自动验证签名）
await normalUser.cert.import(cert);
```

### 查询与检查

```javascript
// 查询特定角色的证书
const editorCerts = await user.cert.query({ role: "editor" });

// 检查是否拥有某证书
const hasEditorRole = await user.cert.has({
  role: "editor",
  issuer: admin.userId
});
```

### 统计与遍历

```javascript
// 统计证书数量
const total = await user.cert.count();
const editorCount = await user.cert.count({ role: "editor" });

// 遍历所有证书（内存友好，使用游标）
for await (const cert of user.cert.values()) {
  console.log(`证书: ${cert.role} - ${cert.subject}`);
}

// 遍历特定条件的证书
for await (const cert of user.cert.values({ role: "editor" })) {
  console.log(`编辑权限: ${cert.subject}`);
}
```

### 删除证书

```javascript
await user.cert.delete(cert.id);
const hasCert = await user.cert.has({ role: "editor" });
console.log(hasCert); // false
```

## 远程用户与消息收发

本地用户可以通过 `connectUser(userId)` 连接到另一个在线用户，获得一个 `RemoteUser` 实例，用于发送消息、测量延迟等。

### 连接远程用户

```javascript
const user = await getUser("my-namespace");
// getUser() 已自动连接默认服务器，通常无需手动 connect
// 如需连接非默认服务器：await user.server.connect("ws://example.com:8081");

const remoteUser = await user.connectUser(targetUserId);
console.log(remoteUser.userId); // 目标用户的 userId
```

`connectUser` 会查询所有已连接的服务器，确认目标用户在线后返回 `RemoteUser`。同一 userId 多次调用会复用缓存实例。

### 获取对方 Session 列表

```javascript
const sessionIds = await remoteUser.getSessionIds();
```

### 发送消息

```javascript
// 发送普通对象（若双方已交换名片，会自动启用 E2EE 加密）
await remoteUser.send(sessionIds[0], { text: "hello", num: 42 });

// 发送二进制数据
const binary = new Uint8Array([0x01, 0x02, 0x03]);
await remoteUser.send(sessionIds[0], binary);

// 发送纯文本
await remoteUser.send(sessionIds[0], "hello");
```

**返回值：** `{ status: "ok", via: "rtc"|"server", url?: string, result?: object }`

- 默认对纯对象启用 E2EE 加密（需双方先通过 `user.card.get()` 交换名片）
- 第一次发送走服务器中转；第二次开始后台静默尝试 WebRTC 直连
- 若 WebRTC DataChannel 已就绪，优先走 RTC
- `raw=true` 为内部参数，跳过 E2EE（如名片协议自身）

### 接收消息

监听 `RemoteUser` 的 `message` 事件：

```javascript
remoteUser.bind("message", (event) => {
  const { fromUserId, fromSessionId, data, viaServer } = event.detail;
  console.log("收到来自", fromUserId, "的消息:", data);
});
```

也可直接监听 `LocalUser` 的 `message` 事件获取所有 relay 消息。

### 延迟测量

```javascript
const rtt = await remoteUser.ping(sessionIds[0]);
console.log("RTT:", rtt, "ms");

// 获取最近一次测量结果
console.log(remoteUser.getRTT(sessionIds[0]));
// { rtt: 23, via: "server", url: "ws://localhost:8081" }

// 不传 sessionId 返回所有 session 中最佳 RTT
console.log(remoteUser.getRTT());
```

`rtt_update` 事件会在每次 ping 成功后触发：

```javascript
user.bind("rtt_update", (event) => {
  console.log(event.detail); // { userId, sessionId, rtt, via, url }
});
```

---

## 用户导出/导入/删除

用户模块提供完整生命周期管理函数。

### 导出用户

```javascript
import { exportUser } from "/nos/user/main.js";

const encrypted = await exportUser("my-namespace", "password");
// 返回 base64 加密的字符串，包含密钥对和用户信息
```

### 导入用户

```javascript
import { importUser } from "/nos/user/main.js";

const user = await importUser("new-namespace", encrypted, "password");
// 若目标 namespace 已存在会抛出错误
```

### 删除用户

```javascript
import { deleteUser } from "/nos/user/main.js";

// 默认弹出两次确认对话框
await deleteUser("my-namespace");

// 跳过确认（适合脚本/测试）
await deleteUser("my-namespace", { skipConfirm: true });
```

删除会永久清除该 namespace 对应的 IndexedDB 数据库、内存缓存和所有本地数据。

---

## LocalUser 事件总览

`LocalUser` 继承自 `EventTarget`，可通过 `bind(eventName, callback)` 监听以下事件：

| 事件名 | 触发时机 | `event.detail` |
|--------|---------|----------------|
| `handshake` | 服务器握手完成或失败 | `{ url, status: "success"|"error", isAdmin?, version?, message? }` |
| `message` | 收到服务器或 RTC 转发消息 | `{ url, data, originalEvent }` |
| `close` | 服务器连接断开 | `{ url }` |
| `ws_error` | WebSocket 连接错误 | `{ url, error }` |
| `latency_test` | 单次延迟测试完成 | `{ url, rtt, oneWayLatency, clientTime, serverRecvTime, serverSendTime, clientRecvTime }` |
| `latency_monitor` | 延迟监测启动 | `{ status: "started", intervalMs }` |
| `rtt_update` | 用户间 ping 完成 | `{ userId, sessionId, rtt, via, url }` |
| `rtc_state` | WebRTC 连接状态变化 | `{ userId, sessionId, state: "connected"|"disconnected" }` |
| `card_received` | 收到并验证远程用户名片 | `{ userId, card, saved }` |

示例：

```javascript
const user = await getUser("my-namespace");

user.bind("handshake", (e) => {
  console.log("握手:", e.detail.url, e.detail.status, e.detail.version);
});

user.bind("message", (e) => {
  console.log("收到消息:", e.detail.url, e.detail.data);
});
```

---

## 服务器连接与延迟监测

每个 `LocalUser` 实例内置 `ServerManager`，通过 `user.server` 访问。`ready()` 完成后会自动尝试连接默认服务器列表。

### 连接服务器

```javascript
const user = await getUser("my-namespace");

// 连接指定服务器
const result = await user.server.connect("ws://localhost:8081");
console.log(result.success, result.version);

// 连接列表中所有服务器
await user.server.connectAll();
```

连接成功后服务器地址会被持久化。默认服务器列表为 `["ws://localhost:8081", "ws://localhost:8082"]`。

> **通常不需要手动连接**：`getUser()` 内部会调用 `ready()`，`ready()` 会自动执行 `connectAll()`，因此多数场景下直接 `await getUser("namespace")` 即可。只有需要连接非默认服务器时，才显式调用 `connect(url)`。

### 服务器列表管理

```javascript
const servers = await user.server.getServers();
await user.server.addServer("ws://example.com:8081");
await user.server.removeServer("ws://example.com:8081");
```

### 延迟测试与监测

```javascript
// 单次测试
const latency = await user.server.testLatency("ws://localhost:8081");
console.log(latency.rtt, latency.oneWayLatency);

// 启动周期性监测（默认 30 秒）
user.server.startLatencyMonitor();

// 停止
user.server.stopLatencyMonitor();
```

`testLatency` 返回：

```javascript
{
  rtt,              // 往返延迟（ms）
  oneWayLatency,    // 单向延迟估算（ms）
  clientTime,       // 客户端发送时间
  serverRecvTime,   // 服务器接收时间
  serverSendTime,   // 服务器发送时间
  clientRecvTime    // 客户端接收时间
}
```

连接成功后会自动启动静默延迟监测；所有连接断开后自动停止。

### 断开连接

```javascript
user.server.disconnect("ws://localhost:8081");
user.server.disconnectAll();
```

## 完整示例

```javascript
import { getUser } from "/nos/user/main.js";

// 创建管理员和普通用户
const admin = await getUser("admin-space");
const user = await getUser("user-space");

// 更新用户个人信息
await user.updateInfo({
  nickname: "普通用户",
  email: "user@example.com"
});

const userInfo = await user.getInfo();
console.log("用户昵称:", userInfo.nickname);
console.log("默认用户名:", userInfo.username);

// 管理员签发证书
const cert = await admin.cert.issue({
  subject: user.userId,
  role: "editor",
  permissions: ["read", "write"]
});

// 用户导入并验证证书
await user.cert.import(cert);

// 检查权限
const hasEditorRole = await user.cert.has({
  role: "editor",
  issuer: admin.userId
});
console.log("拥有编辑权限:", hasEditorRole);

// 统计证书
const totalCount = await user.cert.count();
console.log(`总共有 ${totalCount} 个证书`);

// 遍历证书
for await (const c of user.cert.values()) {
  console.log(`证书: ${c.role} - ${c.subject}`);
}

// 签名和验证文档
const document = { title: "Important Doc", content: "..." };
const signedDoc = await admin.sign(document);
console.log("文档签名有效:", await admin.verify(signedDoc));
```

## API 文档

### getUser(namespace)

获取用户实例的推荐方式。

**参数：**
- `namespace` (string) - 用户命名空间

**返回值：** Promise\<LocalUser\> - 已准备好的用户实例

**特性：**
- 自动缓存用户实例
- 自动调用 `ready()` 准备用户
- 相同命名空间返回同一实例

---

## LocalUser 类

如果需要直接使用 LocalUser 类（例如需要控制初始化时机），可以从 `/nos/user/local/user.js` 引入：

```javascript
import { LocalUser } from "/nos/user/local/user.js";
```

### 构造函数

#### `new LocalUser(namespace)`

创建本地用户实例。

**参数：**
- `namespace` (string) - 用户命名空间，用于区分不同的用户存储空间

**示例：**
```javascript
const user = new LocalUser("my-app-user");
await user.ready();
```

---

### LocalUser 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `namespace` | string | 用户命名空间 |
| `userId` | string | 用户唯一标识（公钥哈希） |
| `publicKey` | string | 用户公钥 |
| `sign` | Function \| null | 签名函数（只读模式返回 null） |
| `cert` | CertManager | 证书管理器实例 |

---

### LocalUser 方法

#### `ready()`

准备用户实例，从数据库加载密钥对，如果不存在则生成新的密钥对并保存。

**返回值：** Promise\<LocalUser\>

#### `sign(data)`

对数据进行签名，自动添加 `signTime` 和 `publicKey` 字段。

**参数：**
- `data` (Object) - 需要签名的数据对象

**返回值：** Promise\<Object\> - 包含原始数据、签名时间戳、公钥和签名的对象

#### `verify(signedData)`

验证数据签名是否正确。

**参数：**
- `signedData` (Object) - 包含 `signature` 字段的已签名数据对象

**返回值：** Promise\<boolean\> - 验证是否通过

#### `updateInfo(data)`

更新用户个人信息。数据会自动签名并存储到数据库，多次调用会合并数据。

**参数：**
- `data` (Object) - 需要更新的用户信息字段

**返回值：** Promise\<Object\> - 更新后的签名用户信息

**特性：**
- 自动添加 `userId` 字段
- 自动签名数据
- 合并现有信息，不会覆盖未更新的字段

#### `getInfo()`

获取已保存的用户信息。

**返回值：** Promise\<Object \| null\> - 已签名的用户信息，如果不存在则返回 null

---

## CertManager 类

证书管理器类，通过 `user.cert` 访问。

### CertManager 方法

#### `issue(options)`

签发证书。

**参数：**
- `options` (Object)
  - `subject` (string) - 被签发人的用户ID（必填）
  - `role` (string) - 角色（必填）
  - `...data` (Object) - 其他附加数据（可选）

**返回值：** Promise\<Object\> - 签发后的证书对象

#### `import(certData)`

验证并导入证书。会自动验证：
- 证书签名是否有效
- `issuer` 是否与公钥匹配

**参数：**
- `certData` (Object) - 包含签名和公钥的证书数据

**返回值：** Promise\<Object\> - 导入后的证书

**抛出错误：**
- 缺少必要字段
- 用户ID与公钥不匹配
- 证书签名验证失败

#### `query(query)`

查询证书。

**参数：**
- `query` (Object) - 查询条件
  - `role` (string) - 角色（可选）
  - `issuer` (string) - 签发者ID（可选）
  - `subject` (string) - 接收者ID（可选）

**返回值：** Promise\<Array\<Object\>\> - 证书数组

#### `has(query)`

检查是否拥有某证书。

**参数：**
- `query` (Object) - 查询条件（同 `query`）

**返回值：** Promise\<boolean\>

#### `delete(id)`

删除证书。

**参数：**
- `id` (string) - 证书ID

**返回值：** Promise\<void\>

#### `count(query)`

获取证书数量。

**参数：**
- `query` (Object) - 查询条件（可选）

**返回值：** Promise\<number\>

#### `values(query)`

获取证书异步迭代器，支持 `for await...of` 语法遍历。使用 IndexedDB 游标实现，内存友好。

**参数：**
- `query` (Object) - 查询条件（可选）

**返回值：** AsyncIterable

## 安全特性

### 密钥管理

- 使用 ECDSA 算法生成密钥对
- 私钥安全存储在 IndexedDB 中
- 用户ID由公钥哈希生成，确保唯一性
- 密钥持久化，重新初始化时自动加载

### 证书验证

保存证书时会自动验证：
1. 必要字段完整性（role、issuer、subject、publicKey、signTime、signature）
2. 签发者ID与公钥匹配
3. 签名有效性

### 防篡改机制

```javascript
// 篡改证书会被检测
const fakeCert = { ...originalCert, issuer: "hacker-id" };
await user.cert.import(fakeCert); // 抛出错误: "用户ID与公钥不匹配"
```

## 测试

查看测试文件了解更多用法：

- [基础用户测试](../../tests/user/base-user.sb.html)
- [基本功能测试](../../tests/user/local/local-user.sb.html)
- [证书管理测试](../../tests/user/local/local-user-cert.sb.html)
- [个人信息测试](../../tests/user/local/local-user-info.sb.html)
- [服务器连接测试](../../tests/user/local/connect-server.sb.html)
- [远程用户与消息收发测试](../../tests/user/local/connect-user.sb.html)
- [用户导出导入测试](../../tests/user/local/user-export-import.sb.html)
- [管理员连接测试](../../tests/user/local/admin-connect-server.sb.html)
