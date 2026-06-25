# 用户信息管理

## 获取用户信息

```javascript
import { getUser } from "/nos/user/main.js";

const user = await getUser("my-user");
const info = await user.getInfo();

console.log(info.userId);    // 用户 ID
console.log(info.username);  // 默认格式为 "user-xxxx"
console.log(info.signature); // 信息签名
console.log(info.signTime);  // 签名时间
console.log(info.publicKey); // 公钥
```

首次初始化时，系统会自动生成默认用户名（格式为 `user-` 加随机字符）。

## 更新用户信息

```javascript
const updated = await user.updateInfo({
  nickname: "测试用户",
  age: 25,
  email: "test@example.com"
});

// 更新后会返回完整的已签名信息
console.log(updated.nickname); // "测试用户"
console.log(!!updated.signature); // true，自动签名
```

## 合并更新

多次 `updateInfo` 会合并字段，不会覆盖未更新的字段：

```javascript
// 第一次更新
await user.updateInfo({ nickname: "初始昵称", city: "北京" });

// 第二次更新（合并）
const merged = await user.updateInfo({
  nickname: "新昵称",
  hobby: "编程"
});

console.log(merged.nickname); // "新昵称"
console.log(merged.city);     // "北京"（保留）
console.log(merged.hobby);    // "编程"（新增）
```

## 信息签名验证

```javascript
const info = await user.getInfo();

// 验证签名是否有效
const valid = await user.verify(info);
console.log(valid); // true

// 篡改后验证
const tampered = { ...info, name: "hacker" };
const invalid = await user.verify(tampered);
console.log(invalid); // false
```
