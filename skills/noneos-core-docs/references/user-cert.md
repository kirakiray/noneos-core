# 证书管理

证书（Certificate）是基于 ECDSA 签名的权限凭证系统，允许一个用户（管理员）为另一个用户签发具有特定角色的证书。

## 签发证书

```javascript
const admin = new LocalUser("admin-user");
const normal = new LocalUser("normal-user");
await Promise.all([admin.ready(), normal.ready()]);

// 管理员签发证书（自动用管理员私钥签名）
const cert = await admin.cert.issue({
  subject: normal.userId,
  role: "editor",
  permission: "all"
});

console.log(cert.id);      // 证书唯一 ID
console.log(cert.issuer);  // 签发者 userId
console.log(cert.subject); // 被签发者 userId
```

## 导入证书

证书接收方需要导入证书才能使用：

```javascript
const imported = await normal.cert.import(cert);

// 导入时会自动验证签名有效性
// 如果证书被篡改（如伪造 issuer），导入会抛出错误
```

## 查询证书

```javascript
// 按角色查询
const editorCerts = await user.cert.query({ role: "editor" });

// 检查是否存在某证书
const hasEditor = await user.cert.has({ role: "editor" });
console.log(hasEditor); // true/false
```

## 删除证书

```javascript
await user.cert.delete(cert.id);

// 删除后查询不再包含该证书
const stillHas = await user.cert.has({ role: "editor" });
console.log(stillHas); // false
```

## 证书计数

```javascript
const total = await user.cert.count();            // 全部证书数
const adminCount = await user.cert.count({ role: "admin" }); // 按条件计数
```

## 证书遍历

```javascript
// 遍历所有证书
for await (const cert of user.cert.values()) {
  console.log(cert.role, cert.subject);
}

// 按条件遍历
for await (const cert of user.cert.values({ role: "admin" })) {
  console.log(cert);
}
```

## 安全验证

导入证书时，系统会验证：
1. 签名是否与签发者公钥匹配
2. 签发者 `issuer` 字段是否与实际的签名者一致

```javascript
// 篡改证书会被拦截
const fakeCert = await hacker.cert.issue({ subject: hacker.userId, role: "admin" });
fakeCert.issuer = victim.userId; // 伪造签发者

try {
  await victim.cert.import(fakeCert);
} catch (err) {
  // 导入失败，篡改被检测到
}
```
