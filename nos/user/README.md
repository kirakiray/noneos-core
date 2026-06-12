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

`getUser` 会自动：
- 创建或获取已缓存的用户实例
- 调用 `ready()` 准备用户
- 返回已准备好的用户实例

### 用户实例缓存

多次调用 `getUser` 使用相同命名空间会返回同一个实例：

```javascript
// 第一次获取
const user1 = await getUser("app-user");
console.log(user1.userId); // 例如: "abc123..."

// 第二次获取相同命名空间
const user2 = await getUser("app-user");
console.log(user1 === user2); // true (同一个实例)
console.log(user2.userId); // 相同的 "abc123..."
```

### 数据签名与验证

```javascript
const user = await getUser("signer");

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

## 个人信息管理

### 更新用户信息

用户可以更新自己的个人信息，数据会自动签名并存储：

```javascript
const user = await getUser("my-user");

// 更新用户信息
const info = await user.updateInfo({
  nickname: "我的昵称",
  age: 25,
  email: "user@example.com",
  avatar: "https://example.com/avatar.png"
});

console.log(info.nickname);    // "我的昵称"
console.log(info.userId);      // 用户ID
console.log(info.signature);   // 数据签名
console.log(info.signTime);    // 签名时间
```

### 获取用户信息

```javascript
const user = await getUser("my-user");

// 获取已保存的用户信息
const userInfo = await user.getInfo();

console.log(userInfo.username);  // 默认用户名 "user-xxxxx"
console.log(userInfo.nickname);  // 用户设置的昵称
console.log(userInfo.userId);    // 用户ID
```

### 信息合并更新

多次调用 `updateInfo` 会合并数据，不会覆盖未更新的字段：

```javascript
const user = await getUser("my-user");

// 第一次更新
await user.updateInfo({
  nickname: "初始昵称",
  city: "北京"
});

// 第二次更新（只更新 nickname，city 会保留）
await user.updateInfo({
  nickname: "新昵称",
  hobby: "编程"
});

// 获取最终信息
const info = await user.getInfo();
console.log(info.nickname); // "新昵称"
console.log(info.city);     // "北京"（保留）
console.log(info.hobby);    // "编程"（新增）
```

### 验证信息签名

用户信息包含签名，可以验证数据完整性：

```javascript
const user = await getUser("my-user");
const info = await user.getInfo();

// 验证签名有效性
const isValid = await user.verify(info);
console.log(isValid); // true

// 篡改数据后验证
const tamperedInfo = { ...info, nickname: "篡改昵称" };
const isTamperedValid = await user.verify(tamperedInfo);
console.log(isTamperedValid); // false
```

### 默认用户名

首次初始化用户时，系统会自动生成默认用户名：

```javascript
const user = await getUser("new-user");
const info = await user.getInfo();

console.log(info.username); // "user-abc12345"（随机8位）
```

## 证书管理

### 签发证书

管理员用户可以为其他用户签发证书：

```javascript
const admin = await getUser("admin-user");
const normalUser = await getUser("normal-user");

// 管理员签发证书
const cert = await admin.cert.issue({
  subject: normalUser.userId,  // 被签发人的用户ID
  role: "admin",                 // 角色
  permission: "all"              // 可选的附加数据
});

console.log(cert.id);         // 证书ID
console.log(cert.issuer);     // 签发者ID（admin.userId）
console.log(cert.subject);    // 接收者ID（normalUser.userId）
console.log(cert.role);       // "admin"
console.log(cert.signature);  // 签名
```

### 导入证书

接收者可以导入证书，系统会自动验证签名有效性：

```javascript
// 接收者导入证书
const importedCert = await normalUser.cert.import(cert);

// 如果证书被篡改，会抛出错误
try {
  const fakeCert = { ...cert, issuer: "fake-user-id" };
  await normalUser.cert.import(fakeCert);
} catch (err) {
  console.error("证书验证失败:", err.message);
}
```

### 查询证书

```javascript
// 查询所有特定角色的证书
const adminCerts = await user.cert.query({ role: "admin" });

// 查询特定签发者的证书
const certsFromAdmin = await user.cert.query({
  issuer: admin.userId
});

// 查询特定条件的证书
const specificCert = await user.cert.query({
  role: "admin",
  issuer: admin.userId,
  subject: normalUser.userId
});
```

### 检查证书

```javascript
// 检查是否拥有某证书
const hasAdminCert = await user.cert.has({
  role: "admin",
  issuer: admin.userId,
  subject: user.userId
});

console.log(hasAdminCert); // true 或 false
```

### 删除证书

```javascript
// 删除证书
await user.cert.delete(cert.id);

// 验证是否已删除
const hasCert = await user.cert.has({ role: "admin" });
console.log(hasCert); // false
```

### 统计证书数量

```javascript
// 获取所有证书数量
const totalCount = await user.cert.count();

// 获取特定角色的证书数量
const adminCount = await user.cert.count({ role: "admin" });

// 获取特定签发者签发的证书数量
const count = await user.cert.count({ issuer: admin.userId });

console.log(`总共有 ${totalCount} 个证书`);
console.log(`其中 ${adminCount} 个是管理员证书`);
```

### 遍历证书

```javascript
// 遍历所有证书（内存友好，使用游标）
for await (const cert of user.cert.values()) {
  console.log(`证书: ${cert.role} - ${cert.subject}`);
  
  // 可以在遍历过程中处理每个证书
  if (cert.signTime < Date.now() - 31536000000) {
    console.log(`过期证书: ${cert.id}`);
  }
}

// 遍历特定角色的证书
for await (const cert of user.cert.values({ role: "admin" })) {
  console.log(`管理员证书: ${cert.subject}`);
}

// 遍历复合条件的证书
for await (const cert of user.cert.values({
  role: "admin",
  issuer: admin.userId
})) {
  console.log(`符合条件的证书: ${cert.id}`);
}
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

**示例：**
```javascript
const user = await getUser("my-app-user");
```

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
```

---

### LocalUser 属性

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

#### `cert`

获取证书管理器实例。

**返回值：** CertManager

```javascript
console.log(user.cert); // CertManager 实例
```

---

### LocalUser 方法

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

#### `updateInfo(data)`

更新用户个人信息。数据会自动签名并存储到数据库，多次调用会合并数据。

**参数：**
- `data` (Object) - 需要更新的用户信息字段

**返回值：** Promise\<Object\> - 更新后的签名用户信息

**特性：**
- 自动添加 `userId` 字段
- 自动签名数据
- 合并现有信息，不会覆盖未更新的字段

**示例：**
```javascript
const info = await user.updateInfo({
  nickname: "我的昵称",
  age: 25,
  email: "user@example.com"
});
// 返回: { nickname: "我的昵称", age: 25, email: "...", userId: "...", signTime: 1234567890, publicKey: "...", signature: "..." }
```

#### `getInfo()`

获取已保存的用户信息。

**返回值：** Promise\<Object | null\> - 已签名的用户信息，如果不存在则返回 null

**示例：**
```javascript
const userInfo = await user.getInfo();
console.log(userInfo.username);  // 默认用户名
console.log(userInfo.nickname);  // 用户设置的昵称
```

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

**示例：**
```javascript
const cert = await admin.cert.issue({
  subject: user.userId,
  role: "editor",
  permissions: ["read", "write"]
});
```

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

**示例：**
```javascript
const importedCert = await user.cert.import(cert);
```

#### `query(query)`

查询证书。

**参数：**
- `query` (Object) - 查询条件
  - `role` (string) - 角色（可选）
  - `issuer` (string) - 签发者ID（可选）
  - `subject` (string) - 接收者ID（可选）

**返回值：** Promise\<Array\<Object\>\> - 证书数组

**示例：**
```javascript
const certs = await user.cert.query({ role: "admin" });
```

#### `has(query)`

检查是否拥有某证书。

**参数：**
- `query` (Object) - 查询条件（同 `query`）

**返回值：** Promise\<boolean\>

**示例：**
```javascript
const hasCert = await user.cert.has({
  role: "admin",
  issuer: admin.userId
});
```

#### `delete(id)`

删除证书。

**参数：**
- `id` (string) - 证书ID

**返回值：** Promise\<void\>

**示例：**
```javascript
await user.cert.delete(cert.id);
```

#### `count(query)`

获取证书数量。

**参数：**
- `query` (Object) - 查询条件
  - `role` (string) - 角色（可选）
  - `issuer` (string) - 签发者ID（可选）
  - `subject` (string) - 接收者ID（可选）

**返回值：** Promise\<number\>

**示例：**
```javascript
// 获取所有证书数量
const totalCount = await user.cert.count();

// 获取特定角色的证书数量
const adminCount = await user.cert.count({ role: "admin" });

// 获取复合条件的证书数量
const count = await user.cert.count({
  role: "admin",
  issuer: admin.userId
});
```

#### `values(query)`

获取证书异步迭代器，支持 `for await...of` 语法遍历。使用 IndexedDB 游标实现，内存友好。

**参数：**
- `query` (Object) - 查询条件
  - `role` (string) - 角色（可选）
  - `issuer` (string) - 签发者ID（可选）
  - `subject` (string) - 接收者ID（可选）

**返回值：** AsyncIterable

**示例：**
```javascript
// 遍历所有证书
for await (const cert of user.cert.values()) {
  console.log("证书:", cert.role, cert.subject);
}

// 遍历特定角色的证书
for await (const cert of user.cert.values({ role: "admin" })) {
  console.log("管理员证书:", cert.subject);
}

// 遍历复合条件的证书
for await (const cert of user.cert.values({
  role: "admin",
  issuer: admin.userId
})) {
  console.log("符合条件的证书:", cert);
}
```

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

// 用户导入证书
await user.cert.import(cert);

// 检查权限
const hasEditorRole = await user.cert.has({
  role: "editor",
  issuer: admin.userId
});

console.log("拥有编辑权限:", hasEditorRole);

// 统计证书数量
const totalCount = await user.cert.count();
const adminCount = await user.cert.count({ role: "admin" });
console.log(`总共有 ${totalCount} 个证书，其中 ${adminCount} 个是管理员证书`);

// 遍历所有证书
for await (const cert of user.cert.values()) {
  console.log(`证书: ${cert.role} - ${cert.subject}`);
}

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
- [个人信息测试](../../tests/user/local/local-user-info.sb.html)