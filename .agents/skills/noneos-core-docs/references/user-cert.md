# 证书管理

证书（Certificate）是基于 ECDSA 签名的权限凭证系统，允许一个用户（管理员）为另一个用户签发具有特定角色的证书。

> **统一凭证管理**：个人资料（profile）与证书由同一个管理器（`CredentialManager`）统一管理，入口为 `user.cred`。
>
> **统一凭证存储**：个人资料（profile）与证书存于同一个凭证库。个人资料即 `role="profile"` 的**自签**证书（`issuer === subject` = 持有者自己）；`role="profile"` 是系统保留角色，导入时强制自签校验，任何人自签的角色都不构成授权，权限判断不应使用该角色。

## 签发证书

```javascript
const admin = new LocalUser("admin-user");
const normal = new LocalUser("normal-user");
await Promise.all([admin.ready(), normal.ready()]);

// 管理员签发证书（自动用管理员私钥签名）
const cert = await admin.cred.issue({
  subject: normal.userId,
  role: "editor",
  permission: "all"
});

console.log(cert.id);      // 证书唯一 ID
console.log(cert.issuer);  // 签发者 userId
console.log(cert.subject); // 被签发者 userId
console.log(cert.expire);  // 过期时间戳（绝对时间）
```

### 过期时间（expire）

授权类证书有过期时间，`expire` 为绝对时间戳，随证书内容一同签名（被签名保护，无法篡改期限）：

```javascript
// 不传 expire：默认签发后 30 天
await admin.cred.issue({ subject: normal.userId, role: "editor" });

// 显式指定过期时间戳
await admin.cred.issue({
  subject: normal.userId,
  role: "editor",
  expire: Date.now() + 7 * 24 * 60 * 60 * 1000, // 7 天后
});

// 永不过期：显式传 null（证书不携带 expire 字段）
await admin.cred.issue({ subject: normal.userId, role: "editor", expire: null });
```

规则：

- 导入时校验 `expire`：必须是有效数字、晚于 `signTime`、且未过期（±5 分钟时钟容差）；已过期的证书拒绝导入
- `query`/`count`/`values` 默认**过滤已过期记录**，传第二参 `{ includeExpired: true }` 才包含；`has` 始终不含过期记录
- 无主动清理定时器，过期采用惰性判断；过期记录仍留在库中，可用 `delete` 手动删除
- 个人资料（`role="profile"`）无过期语义，不参与 expire 校验与过滤

## 导入证书

证书接收方需要导入证书才能使用：

```javascript
const imported = await normal.cred.import(cert);

// 导入时会自动验证签名有效性
// 如果证书被篡改（如伪造 issuer），导入会抛出错误
```

## 分享证书（用户间互传）

除了手动传递证书对象，还可以直接通过网络把证书分享给对方：

```javascript
// admin 签发证书后，直接推送给 normal（需对方在线）
const remote = await admin.connectUser(normal.userId);
await remote.shareCert(cert);
```

接收端收到后会走同一条导入路径（验证签名 → signTime 收敛入库），并触发 `cert_received` 事件：

```javascript
normal.bind("cert_received", (event) => {
  console.log(event.detail.fromUserId); // 分享者 userId
  console.log(event.detail.saved);      // 是否实际写入（重复分享为 false）
  console.log(event.detail.cert);       // 最终保留的证书记录
});
```

说明：

- 传输自动选路：双方已交换资料时 E2EE 加密，否则明文中继（证书自带签名，完整性不受影响）
- 幂等：按 signTime 收敛，重复分享安全
- 对方离线时 `shareCert` 抛出 `code: "offline"` 错误
- 接收端只验证密码学有效性；「谁签发的证书算数」由应用在 `query/has` 消费时自行判断

## 查询证书

```javascript
// 按角色查询
const editorCerts = await user.cred.query({ role: "editor" });

// 检查是否存在某证书
const hasEditor = await user.cred.has({ role: "editor" });
console.log(hasEditor); // true/false
```

### 分页查询（keyset）

`query` 第二参传 `limit` 即启用分页，返回 `{ items, nextCursor, hasMore }`；把 `nextCursor` 传回 `after` 继续取下一页：

```javascript
// 第一页
const page1 = await user.cred.query({ role: "editor" }, { limit: 50 });
// page1.items / page1.hasMore / page1.nextCursor

// 下一页（nextCursor 为 null 表示到底）
if (page1.hasMore) {
  const page2 = await user.cred.query(
    { role: "editor" },
    { limit: 50, after: page1.nextCursor },
  );
}
```

说明：

- **keyset 分页**：只能顺序向后翻页（没有"跳到第 N 页"的 offset 语义）；游标是不透明 token，记录按索引顺序排列，翻页不重不漏
- 已过期记录默认被过滤且**不占 limit 额度**（页面不会因过期记录缩水）；与 `includeExpired: true` 可组合使用
- 响应**不包含总数**：需要显示"共 N 条"时另调 `count()`
- 不传 `limit` 时行为不变，一次性返回全部匹配记录的数组

## 删除证书

```javascript
await user.cred.delete(cert.id);

// 删除后查询不再包含该证书
const stillHas = await user.cred.has({ role: "editor" });
console.log(stillHas); // false
```

## 证书计数

```javascript
const total = await user.cred.count();            // 全部证书数
const adminCount = await user.cred.count({ role: "admin" }); // 按条件计数
```

## 证书遍历

```javascript
// 遍历所有证书
for await (const cert of user.cred.values()) {
  console.log(cert.role, cert.subject);
}

// 按条件遍历
for await (const cert of user.cred.values({ role: "admin" })) {
  console.log(cert);
}
```

## 安全验证

导入证书时，系统会验证：
1. 签名是否与签发者公钥匹配
2. 签发者 `issuer` 字段是否与实际的签名者一致
3. `expire` 是否为有效时间戳、晚于 `signTime` 且尚未过期（profile 例外）

### 底层验证机制

证书统一导入路径（`cert.import` / `cert.importRecord`）内部使用**规范化排序验签**：剥离 `id` 与 `signature` 字段后，将剩余字段**按 key 字母序排序**再 `JSON.stringify`，与 `BaseUser._sign` 的签名规则完全一致。相比直接 `JSON.stringify`，它不依赖对象属性插入顺序，记录中途经过任何序列化/重构都不会破坏验签。

```javascript
// 签名方（_sign）与验证方（cert 导入路径）使用相同的规范化序列化：
// 1. 按 key 字母序排序字段
// 2. JSON.stringify 后做 ECDSA 验签（signature 为 base64）
```

> 如需在无用户实例的场景下独立验签任意签名数据，可使用 [verifyData](https://raw.githubusercontent.com/kirakiray/noneos-core/refs/heads/main/nos/crypto/crypto-verify.js)——但它按字段原顺序序列化，要求待验数据保留签名方的字段顺序（`JSON` 传输通常能保留）。类似模式也用于其他场景的数据签名验证，参见 [data-publisher.sb.html](https://raw.githubusercontent.com/kirakiray/noneos-core/refs/heads/main/tests/publish/data-publisher.sb.html) 中的验证流程。

### 篡改检测示例

```javascript
// 篡改证书会被拦截
const fakeCert = await hacker.cred.issue({ subject: hacker.userId, role: "admin" });
fakeCert.issuer = victim.userId; // 伪造签发者

try {
  await victim.cred.import(fakeCert);
} catch (err) {
  // 导入失败，篡改被检测到
}
```
