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

- [基本功能测试](../../tests/user/local/local-user.sb.html)
- [证书管理测试](../../tests/user/local/local-user-cert.sb.html)
- [个人信息测试](../../tests/user/local/local-user-info.sb.html)
