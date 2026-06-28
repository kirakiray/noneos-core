# LocalUser 基础 — 创建、初始化、持久化与签名

## 创建与初始化

```javascript
import { LocalUser } from "/nos/user/user.js";

const user = new LocalUser("my-namespace");
await user.ready();

console.log(user.userId);      // 用户唯一标识（公钥哈希）
console.log(user.publicKey);   // 用户公钥
console.log(user.namespace);   // 命名空间
```

## 密钥持久化

相同 `namespace` 的 LocalUser 会自动复用已生成的密钥对：

```javascript
const user1 = new LocalUser("persist-ns");
await user1.ready();
const firstUserId = user1.userId;

// 再次创建同一 namespace 的用户
const user2 = new LocalUser("persist-ns");
await user2.ready();

console.log(user2.userId === firstUserId); // true，密钥已持久化
```

## 签名与验证

```javascript
const data = { message: "Hello", timestamp: Date.now() };

// 签名：返回包含 signature、signTime、publicKey 的对象
const signed = await user.sign(data);

console.log(!!signed.signature);  // true
console.log(!!signed.signTime);   // true
console.log(!!signed.publicKey);  // true

// 验证签名
const valid = await user.verify(signed);
console.log(valid); // true

// 篡改数据后验证失败
const tampered = { ...signed, message: "Tampered!" };
const invalid = await user.verify(tampered);
console.log(invalid); // false
```

## 获取本用户所有 Session ID

同一个 `namespace` 可以在多个标签页中创建 LocalUser，`getSessionIds()` 可发现所有在线 session：

```javascript
const sessionIds = await user.getSessionIds(100);
console.log(Array.isArray(sessionIds)); // true
// 返回所有同 namespace 的 sessionId
```
