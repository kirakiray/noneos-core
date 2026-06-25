# 用户导出/导入/删除

## 导出用户

导出用户密钥和信息到加密字符串：

```javascript
import { getUser, exportUser } from "/nos/user/main.js";

const user = await getUser("my-ns");
await user.updateInfo({ username: "test_user" });

// 使用密码加密导出
const encrypted = await exportUser("my-ns", "my-password");
console.log(typeof encrypted); // string
console.log(encrypted.length > 0); // true
```

导出的数据包含：namespace、密钥对（publicKey + privateKey）、用户信息、exportTime。

### 解密导出数据

```javascript
import { decryptWithPassword } from "/nos/crypto/crypto-aes.js";

const decrypted = await decryptWithPassword("my-password", encrypted);
const data = JSON.parse(decrypted);
console.log(data.namespace);  // "my-ns"
console.log(data.keys);       // { publicKey, privateKey }
console.log(data.info);       // 用户信息
```

## 导入用户

将导出的用户数据导入到新的 namespace：

```javascript
import { importUser } from "/nos/user/main.js";

const importedUser = await importUser("new-ns", encrypted, "my-password");
console.log(importedUser.userId); // 与导出时的 userId 一致

// 用户信息也一并恢复
const info = await importedUser.getInfo();
console.log(info.username); // "test_user"
```

### 错误密码

使用错误密码导入会抛出异常：

```javascript
try {
  await importUser("target-ns", encrypted, "wrong-password");
} catch (error) {
  // 导入失败
}
```

### 重复命名空间

目标 namespace 已存在用户时，导入会失败：

```javascript
try {
  await importUser("existing-ns", encrypted, "password");
} catch (error) {
  // error.message 包含 "already exists"
}
```

## 删除用户

```javascript
import { deleteUser } from "/nos/user/main.js";

// 跳过确认直接删除
await deleteUser("my-ns", { skipConfirm: true });
```

删除不存在的用户会抛出异常：

```javascript
try {
  await deleteUser("non-existent-ns");
} catch (error) {
  // error.message 包含 "not found"
}
```

## 导出不存在的用户

```javascript
try {
  await exportUser("non-existent-ns", "password");
} catch (error) {
  // error.message 包含 "not found"
}
```

## 特殊字符支持

用户名和信息中的特殊字符在导出/导入过程中保持完整：

```javascript
await user.updateInfo({
  username: "测试用户_特殊字符",
  bio: "包含特殊字符：!@#$%^&*()_+-="
});

// 导出后再导入，特殊字符完整保留
```
