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

// 管理员签发证书
const cert = await admin.cert.issue({
  subject: normalUser.userId,
  role: "editor"
});

// 用户导入证书
await normalUser.cert.import(cert);
```

### 查询与删除

```javascript
// 查询
const editorCerts = await user.cert.query({ role: "editor" });

// 检查
const hasEditorRole = await user.cert.has({ role: "editor" });

// 删除
await user.cert.delete(cert.id);
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
| `traffic` | 流量记录器（`TrafficLogger`），详见 [客户端流量统计](traffic.md) |

#### LocalUser 事件

| 事件 | 说明 |
|------|------|
| `remote_user_connected` | `connectUser()` 成功或收到对方消息后创建 RemoteUser。detail: `{ userId, remoteUser, initiatedBy }` |
| `remote_user_disconnected` | `disconnectUser()` 或 `connectUser()` 失败。detail: `{ userId, remoteUser, reason, error }` |
| `message` | 通过服务器中继收到消息 |
| `rtt_update` | RTT 延迟更新 |
| `card_received` | 收到名片 |

### CertManager 类 (user.cert)

| 方法 | 说明 |
|------|------|
| `issue(options)` | 签发证书 |
| `import(certData)` | 导入并验证证书 |
| `query(query)` | 查询证书 |
| `has(query)` | 检查是否拥有某证书 |
| `delete(id)` | 删除证书 |
| `count(query)` | 获取证书数量 |
| `values(query)` | 获取证书异步迭代器 |
