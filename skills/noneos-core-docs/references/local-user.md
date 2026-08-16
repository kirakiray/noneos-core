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

## 用户专属存储（User Storage）

每个 `LocalUser` 都拥有独立的存储空间，通过 `user.getStorage(name)` 获取，底层复用 [nos/storage](storage.md)。存储 id 为 `user:<namespace>:<userId>:<name>`，对应独立的 IndexedDB 数据库，因此**不同用户、同一用户不同身份之间互不可见**。

```javascript
const user = await getUser("my-app");

// 获取该用户专属的存储空间（name 可选，默认 "default"）
const settings = await user.getStorage("settings");

await settings.setItem("theme", "dark");
const theme = await settings.getItem("theme"); // "dark"
```

注意：

- `getStorage(name)` 是 **async** 方法（内部先 `await ready()` 并登记到用户库，供 `deleteUser` 联动清理）
- 同名子空间复用同一实例；跨标签页同步只在该用户同名的子空间内生效
- 支持 `nos/storage` 的全部能力：复杂类型、nos/fs 句柄、遍历、代理语法等
- 调用 `deleteUser(namespace)` 时会联动删除该用户通过 `getStorage()` 创建的全部专属存储

## 共享存储（只读）

若要让**远端用户**只读访问某个专属存储空间，先以 `share:` 前缀创建空间，再用 `shareStorage()` 显式开放。只有以 `share:` 开头的空间可被共享，其余存储远端无法访问。

```javascript
const user = await getUser("my-app");

// 显式开放共享（只读）
const revoke = await user.shareStorage("share:settings");

// 随时关闭共享
await revoke();
```

注意：

- `shareStorage(name)` 是 **async** 方法；`name` 必须以 `share:` 开头，否则抛错
- **只读**：远端用户只能读取该空间，无法写入
- 重复开启同一空间幂等，不会重复登记
- 返回的 revoke 函数可随时关闭共享，多次调用安全
- 共享登记持久化在用户库 `shared-storages` 键中，删除用户时随之清除

## 获取本用户所有 Session ID

同一个 `namespace` 可以在多个标签页中创建 LocalUser，`getSessionIds()` 可发现所有在线 session：

```javascript
const sessionIds = await user.getSessionIds(100);
console.log(Array.isArray(sessionIds)); // true
// 返回所有同 namespace 的 sessionId
```

## 管理已连接的远程用户

LocalUser 内部会缓存已经建立通信的远程用户实例，并通过只读 getter 暴露出来：

```javascript
// 当前已缓存的 RemoteUser 列表（主动连接 + 被动收到消息后自动创建）
const list = user.remoteUsers;
console.log(Array.isArray(list)); // true
list.forEach((remoteUser) => {
  console.log(remoteUser.userId);
});
```

### 断开远程用户

```javascript
await user.disconnectUser(targetUserId);
// 清理本地缓存并触发 remote_user_disconnected（reason: "manual"）
```

### 查询用户是否在线

```javascript
const online = await user.isRemoteUserOnline(targetUserId);
// 已缓存用户通过 RemoteUser.getSessionIds() 判断；未缓存用户直接查询已连接服务器
```

### 过滤出当前在线的远程用户

```javascript
const onlineUsers = await user.getRemoteUsers({ onlineOnly: true });
```

## 远程用户连接事件

```javascript
user.bind("remote_user_connected", (event) => {
  const { userId, remoteUser, initiatedBy } = event.detail;
  // initiatedBy: "local" 表示我主动 connectUser 成功
  // initiatedBy: "remote" 表示对方发消息给我，core 被动创建了 RemoteUser
});

user.bind("remote_user_disconnected", (event) => {
  const { userId, remoteUser, reason, error } = event.detail;
  // reason: "manual" 表示我主动 disconnectUser
  // reason: "error"  表示 connectUser 失败
});
```

## 流量统计

LocalUser 内置了流量记录器，自动记录所有服务器中继/RTC 直连消息的元数据（不含内容）：

```javascript
// 开关埋点
user.traffic.setEnabled(false);

// 查询最近 10 条
const recent = await user.traffic.query({ limit: 10 });

// 按对端聚合
const peerTotals = await user.traffic.getPeerTotals();

// 清空
await user.traffic.clearAll();
```

完整 API 参考：[客户端流量统计](traffic.md)。

## 无实例验签：`verifyData`

`user.verify(signed)` 是 `BaseUser` 上的方法（`LocalUser`、`RemoteUser` 均可用），需要先有一个用户实例；如果你只是想验证**任意来源**的签名数据（例如他人签发的证书、别人的名片等），可以直接使用 `verifyData` 工具函数——它不依赖任何用户实例，只要待验数据本身携带 `signature` 与 `publicKey` 字段即可。

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
