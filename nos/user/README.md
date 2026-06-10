# LocalUser - 本地用户管理

LocalUser 是 NoneOS Core 的用户管理模块，提供基于 ECDSA 的密钥管理、数据签名验证和证书管理功能。

## 安装

确保已安装 NoneOS Core，参考 [NoneOS Core 安装文档](https://core.noneos.com)。

## 引入

```javascript
import { LocalUser } from "/nos/user/local/user.js";
```

## 基本用法

### 创建和初始化用户

```javascript
const user = new LocalUser("my-namespace");
await user.ready();

console.log(user.userId);     // 用户唯一标识（公钥哈希）
console.log(user.publicKey);  // 用户公钥
console.log(user.namespace);  // "my-namespace"
```

### 密钥持久化

使用相同命名空间创建的用户会自动加载已保存的密钥：

```javascript
// 第一次创建
const user1 = new LocalUser("app-user");
await user1.ready();
console.log(user1.userId); // 例如: "abc123..."

// 第二次使用相同命名空间
const user2 = new LocalUser("app-user");
await user2.ready();
console.log(user2.userId); // 相同的 "abc123..."
```

### 数据签名与验证

```javascript
const user = new LocalUser("signer");
await user.ready();

// 签名数据
const data = { message: "Hello, World!", timestamp: Date.now() };
const signedData = await user.sign(data);

console.log(signedData.signature);  // Base64 签名
console.log(signedData.signTime);   // 签名时间戳
console.log(signedData.publicKey);  // 签名者公钥

// 验证签名
const isValid = await user.verify(signedData);
console.log(isValid); // true

// 篡改数据后验证
const tamperedData = { ...signedData, message: "Tampered!" };
const isTamperedValid = await user.verify(tamperedData);
console.log(isTamperedValid); // false
```

## 证书管理

### 签发证书

管理员用户可以为其他用户签发证书：

```javascript
const admin = new LocalUser("admin-user");
const normalUser = new LocalUser("normal-user");

await admin.ready();
await normalUser.ready();

// 管理员签发证书
const cert = await admin.issueCert({
  issuedTo: normalUser.userId,  // 被签发人的用户ID
  role: "admin",                 // 角色
  permission: "all"              // 可选的附加数据
});

console.log(cert.id);         // 证书ID
console.log(cert.issuedBy);   // 签发者ID（admin.userId）
console.log(cert.issuedTo);   // 接收者ID（normalUser.userId）
console.log(cert.role);       // "admin"
console.log(cert.signature);  // 签名
```

### 保存证书

接收者可以保存证书，系统会自动验证签名有效性：

```javascript
// 接收者保存证书
const savedCert = await normalUser.saveCert(cert);

// 如果证书被篡改，会抛出错误
try {
  const fakeCert = { ...cert, issuedBy: "fake-user-id" };
  await normalUser.saveCert(fakeCert);
} catch (err) {
  console.error("证书验证失败:", err.message);
}
```

### 查询证书

```javascript
// 查询所有特定角色的证书
const adminCerts = await user.queryCerts({ role: "admin" });

// 查询特定签发者的证书
const certsFromAdmin = await user.queryCerts({
  issuedBy: admin.userId
});

// 查询特定条件的证书
const specificCert = await user.queryCerts({
  role: "admin",
  issuedBy: admin.userId,
  issuedTo: normalUser.userId
});
```

### 检查证书

```javascript
// 检查是否拥有某证书
const hasAdminCert = await user.hasCert({
  role: "admin",
  issuedBy: admin.userId,
  issuedTo: user.userId
});

console.log(hasAdminCert); // true 或 false
```

### 删除证书

```javascript
// 删除证书
await user.deleteCert(cert.id);

// 验证是否已删除
const hasCert = await user.hasCert({ role: "admin" });
console.log(hasCert); // false
```

## API 文档

### 构造函数

#### `new LocalUser(namespace)`

创建本地用户实例。

**参数：**
- `namespace` (string) - 用户命名空间，用于区分不同的用户存储空间

**示例：**
```javascript
const user = new LocalUser("my-app-user");
```

---

### 属性

#### `namespace`

获取用户的命名空间。

**返回值：** string

```javascript
console.log(user.namespace); // "my-app-user"
```

#### `userId`

获取用户唯一标识（公钥哈希）。

**返回值：** string

```javascript
console.log(user.userId); // "a1b2c3d4..."
```

#### `publicKey`

获取用户公钥。

**返回值：** string

```javascript
console.log(user.publicKey); // "-----BEGIN PUBLIC KEY..."
```

#### `sign`

获取签名函数。如果没有私钥（只读模式），返回 null。

**返回值：** Function | null

---

### 方法

#### `ready()`

准备用户实例，从数据库加载密钥对，如果不存在则生成新的密钥对并保存。

**返回值：** Promise\<LocalUser\>

**示例：**
```javascript
const user = new LocalUser("my-user");
await user.ready();
```

#### `sign(data)`

对数据进行签名，自动添加 `signTime` 和 `publicKey` 字段。

**参数：**
- `data` (Object) - 需要签名的数据对象

**返回值：** Promise\<Object\> - 包含原始数据、签名时间戳、公钥和签名的对象

**示例：**
```javascript
const signedData = await user.sign({ message: "Hello" });
// 返回: { message: "Hello", signTime: 1234567890, publicKey: "...", signature: "..." }
```

#### `verify(signedData)`

验证数据签名是否正确。

**参数：**
- `signedData` (Object) - 包含 `signature` 字段的已签名数据对象

**返回值：** Promise\<boolean\> - 验证是否通过

**示例：**
```javascript
const isValid = await user.verify(signedData);
```

#### `issueCert(options)`

签发证书。

**参数：**
- `options` (Object)
  - `issuedTo` (string) - 被签发人的用户ID（必填）
  - `role` (string) - 角色（必填）
  - `...data` (Object) - 其他附加数据（可选）

**返回值：** Promise\<Object\> - 签发后的证书对象

**示例：**
```javascript
const cert = await admin.issueCert({
  issuedTo: user.userId,
  role: "editor",
  permissions: ["read", "write"]
});
```

#### `saveCert(certData)`

验证并保存证书。会自动验证：
- 证书签名是否有效
- `issuedBy` 是否与公钥匹配

**参数：**
- `certData` (Object) - 包含签名和公钥的证书数据

**返回值：** Promise\<Object\> - 保存后的证书

**抛出错误：**
- 缺少必要字段
- 用户ID与公钥不匹配
- 证书签名验证失败

**示例：**
```javascript
const savedCert = await user.saveCert(cert);
```

#### `queryCerts(query)`

查询证书。

**参数：**
- `query` (Object) - 查询条件
  - `role` (string) - 角色（可选）
  - `issuedBy` (string) - 签发者ID（可选）
  - `issuedTo` (string) - 接收者ID（可选）

**返回值：** Promise\<Array\<Object\>\> - 证书数组

**示例：**
```javascript
const certs = await user.queryCerts({ role: "admin" });
```

#### `hasCert(query)`

检查是否拥有某证书。

**参数：**
- `query` (Object) - 查询条件（同 `queryCerts`）

**返回值：** Promise\<boolean\>

**示例：**
```javascript
const hasCert = await user.hasCert({
  role: "admin",
  issuedBy: admin.userId
});
```

#### `deleteCert(id)`

删除证书。

**参数：**
- `id` (string) - 证书ID

**返回值：** Promise\<void\>

**示例：**
```javascript
await user.deleteCert(cert.id);
```

## 安全特性

### 密钥管理

- 使用 ECDSA 算法生成密钥对
- 私钥安全存储在 IndexedDB 中
- 用户ID由公钥哈希生成，确保唯一性
- 密钥持久化，重新初始化时自动加载

### 证书验证

保存证书时会自动验证：
1. 必要字段完整性（role、issuedBy、issuedTo、publicKey、signTime、signature）
2. 签发者ID与公钥匹配
3. 签名有效性

### 防篡改机制

```javascript
// 篡改证书会被检测
const fakeCert = { ...originalCert, issuedBy: "hacker-id" };
await user.saveCert(fakeCert); // 抛出错误: "用户ID与公钥不匹配"
```

## 完整示例

```javascript
import { LocalUser } from "/nos/user/local/user.js";

// 创建管理员和普通用户
const admin = new LocalUser("admin-space");
const user = new LocalUser("user-space");

await admin.ready();
await user.ready();

// 管理员签发证书
const cert = await admin.issueCert({
  issuedTo: user.userId,
  role: "editor",
  permissions: ["read", "write"]
});

// 用户保存证书
await user.saveCert(cert);

// 检查权限
const hasEditorRole = await user.hasCert({
  role: "editor",
  issuedBy: admin.userId
});

console.log("拥有编辑权限:", hasEditorRole);

// 签名和验证
const document = { title: "Important Doc", content: "..." };
const signedDoc = await admin.sign(document);
const isValid = await admin.verify(signedDoc);

console.log("文档签名有效:", isValid);
```

## 测试

查看测试文件了解更多用法：

- [基本功能测试](../../tests/user/local/local-user.sb.html)
- [证书管理测试](../../tests/user/local/local-user-cert.sb.html)