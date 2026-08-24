# 服务器列表管理

每个用户有独立的服务器列表，存储着可用的信令服务器地址。

## 获取服务器列表

```javascript
const servers = await user.server.getServers();
// localhost:3002（本地开发主端口）默认返回：
// ["ws://localhost:8081", "ws://localhost:8082"]
// 其他本地端口（localhost / 127.0.0.1）默认返回：
// ["ws://localhost:8081", "ws://localhost:8082",
//  "wss://hand3-jp1.noneos.com:4331", "wss://hand3-us1.noneos.com:4331", "wss://hand3-hk1.noneos.com:4331"]
// 其他域名下默认只返回三个线上服务器
```

## 添加自定义服务器

```javascript
await user.server.addServer("ws://localhost:9090");

const servers = await user.server.getServers();
// 默认列表末尾追加 "ws://localhost:9090"
```

添加重复的 URL 不会产生重复条目。

## 删除服务器

```javascript
await user.server.removeServer("ws://localhost:9090");

const servers = await user.server.getServers();
// 自定义服务器已移除，保留默认服务器
```

## 持久化

服务器列表存储在 IndexedDB 中，同一 `namespace` 的不同实例共享列表：

```javascript
// 实例 A：添加服务器
const userA = new LocalUser("my-ns");
await userA.ready();
await userA.server.addServer("ws://custom:8080");

// 实例 B（同 namespace）：列表已包含自定义服务器
const userB = new LocalUser("my-ns");
await userB.ready();
const servers = await userB.server.getServers();
// 包含 "ws://custom:8080"
```
