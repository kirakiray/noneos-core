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

## 无实例验签：`verifyData`

`user.verify(signed)` 是 `BaseUser` 上的方法（`LocalUser`、`RemoteUser` 均可用），需要先有一个用户实例；如果你只是想验证**任意来源**的签名数据（例如他人签发的证书、AppManager 的 asset-manifest、别人的名片等），可以直接使用 `verifyData` 工具函数——它不依赖任何用户实例，只要待验数据本身携带 `signature` 与 `publicKey` 字段即可。

```javascript
import { verifyData } from "/nos/crypto/crypto-verify.js";

// signedData 通常来自网络/存储，包含 signature (base64) + publicKey + 业务字段
const isValid = await verifyData(signedData);
console.log(isValid); // true / false
```

### 工作原理

1. 从入参中剥离 `signature` 字段，剩余部分即被签名的数据
2. 使用 `publicKey` 构建 ECDSA 验证器
3. 对剩余数据执行 `JSON.stringify(data)`（保持字段原有顺序）后进行验签

> ⚠️ 签名时 `_sign` 会将字段**按 key 字母序排序**再序列化。验签端只做直接 `JSON.stringify`，因此必须**原样保留发送方给出的字段顺序**——通过 `JSON.parse` 传输通常能自动保留，但如果你手动重建对象（例如展开/合并到新对象里）可能改变顺序导致验签失败。

### 使用场景

- 验证他人发布的 `asset-manifest.json`（AppManager 内部即调用它）
- 验证 [用户证书](user-cert.md) 的合法性与签发者身份
- 验证接收到的名片（card）、离线消息等任何带签名的数据
- 任何**不方便构造用户实例**、或需要独立验签的场景

### 与 `user.verify` 的区别（性能 vs 便利）

`user.verify(signed)` 与 `verifyData(signed)` 在正确性上等价，但在**性能特征**上有明显差异：

| | `user.verify(signed)` (BaseUser) | `verifyData(signed)` |
|--|--|--|
| 归属 | `BaseUser`（`LocalUser`、`RemoteUser` 通用） | 独立工具函数 |
| 验证器（verifier） | **预热**：`ready()` 时通过 `createVerifier(publicKey)` 构造并缓存 | **每次调用都重新构造** |
| 单次验证开销 | 更小（复用已初始化的 verifier） | 更大（每次做一次密钥导入 + 建立验证器） |
| 需要实例 | ⚠️ 必须先有 user 实例 | 不需要 |
| 适用场景 | 高频重复验证同一对端的数据；已持有 user 实例 | 一次性验签、临时数据、后台任务 |

**建议：**
- 对**已知发布者**（如你已 `connectUser` 拿到 `RemoteUser`）的大量数据（例如批量拉取的 manifest / chunk / 消息）验证，用 `remoteUser.verify(...)` / `localUser.verify(...)` **更快**——省去反复初始化验证器的开销。
- 对**陌生 / 一次性 / 零散**的签名数据（例如启动时检查一份本地缓存的证书是否有效），用 `verifyData(...)` **更方便**——不用为验证一次数据而专门构造用户实例。
