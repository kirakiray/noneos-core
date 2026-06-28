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
// 连接指定服务器
await user.server.connect("ws://localhost:8081");

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
