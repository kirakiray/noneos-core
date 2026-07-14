# 客户端流量统计

`LocalUser` 实例上挂载了 `traffic` 管理器，用于记录本地用户所有出站/入站消息的元数据（不含消息内容），并支持查询、聚合与清理。

```javascript
const user = await getUser("my-ns");

// 查看流量记录器
console.log(user.traffic);
```

> 流量记录默认开启。数据持久化在 `nos_user_${namespace}` 数据库的 `traffic_entries`（明细）与 `traffic_agg_minute`（分钟聚合）两个 store 中。

## 开关与配置

### 关闭/开启埋点

```javascript
// 暂停记录（不影响已有数据）
user.traffic.setEnabled(false);

// 恢复记录
user.traffic.setEnabled(true);
```

### 调整刷盘策略

```javascript
user.traffic.configure({
  flushIntervalMs: 500,  // 自动刷盘间隔，默认 500ms
  flushBatchSize: 50,    // 队列满多少条立即刷盘，默认 50
  minSize: 0,            // 小于此字节数的记录被忽略（0 表示不忽略）
  recordCategories: ["app", "service"], // 只记录指定 category，null 表示全部
});
```

## 手动刷盘

测试或需要确保数据已落库时调用：

```javascript
await user.traffic.flush();
```

## 记录内容说明

`traffic` 不保存消息内容，只记录以下元数据：

| 字段 | 说明 |
|------|------|
| `ts` | 时间戳（毫秒） |
| `direction` | `"out"` 出站 / `"in"` 入站 |
| `via` | `"server"` 服务器中继 / `"rtc"` 直连 / `""` 未知 |
| `peerUserId` | 对端用户 ID；广播/服务器消息为空字符串 |
| `sessionId` | 对端会话 ID；广播用 `""` |
| `serverUrl` | 服务器 URL（via 为 server 时） |
| `size` | 实际链路字节数 |
| `category` | 消息分类，见下表 |
| `messageType` | 原始 type 字段 |
| `appId` | category 为 `app` 时的应用 ID |
| `success` | 是否发送成功（失败也会记录，size 为尝试发送字节数） |
| `errorCode` | 失败原因，如 `"not_open"` |

### category 分类

| category | 典型消息 |
|----------|----------|
| `app` | 业务消息（含 `__app` / `__data`） |
| `service` | `__service_query` / `__service_response` |
| `card` | `type === "card"` 名片消息 |
| `rtc_signal` | WebRTC 信令 |
| `handshake` | 握手相关：`handshake_challenge` / `handshake` / `handshake_response` |
| `latency` | 延迟测试：`__ping__` / `__pong__` / `latency_test*` |
| `control` | `update_services` |
| `relay` | 中继转发帧（无法识别内部类型时） |
| `other` | 未分类消息 |

## 明细查询

```javascript
// 最近 10 条记录
const recent = await user.traffic.query({ limit: 10 });

// 按时间范围查询
const rows = await user.traffic.query({
  fromTs: Date.now() - 60 * 1000,
  toTs: Date.now(),
  limit: 100,
});

// 按对端用户过滤
const peerRows = await user.traffic.query({ peerUserId: "xxx" });

// 按服务器 URL、via、category、appId 等组合过滤
const serverRows = await user.traffic.query({
  serverUrl: "ws://localhost:8081",
  category: "app",
  limit: 50,
});
```

### query 参数

| 参数 | 说明 |
|------|------|
| `fromTs` / `toTs` | 时间范围（毫秒） |
| `peerUserId` | 对端用户 ID |
| `sessionId` | 对端 session ID |
| `via` | `"server"` / `"rtc"` |
| `serverUrl` | 服务器 URL |
| `category` | 消息分类 |
| `messageType` | 具体 type 字段 |
| `appId` | 应用 ID |
| `direction` | `"out"` / `"in"` |
| `success` | `true` / `false` |
| `limit` | 返回条数上限，默认 100 |
| `offset` | 偏移量，默认 0 |
| `order` | `"desc"` 默认 / `"asc"` |

## 聚合查询

```javascript
// 按对端用户聚合
const peerTotals = await user.traffic.summary({ groupBy: ["peer"] });

// 按服务器聚合
const serverTotals = await user.traffic.summary({ groupBy: ["server"] });

// 按分钟时间线
const timeline = await user.traffic.summary({ groupBy: ["minute"] });

// 按 category 聚合
const catTotals = await user.traffic.summary({ groupBy: ["category"] });

// 多维度组合
const multi = await user.traffic.summary({
  groupBy: ["peer", "via"],
  fromTs: Date.now() - 60 * 60 * 1000,
});
```

### groupBy 可选维度

| 维度 | 说明 |
|------|------|
| `peer` | 对端用户 |
| `via` | 传输路径 |
| `server` | 服务器 URL |
| `category` | 消息分类 |
| `minute` | 按分钟对齐的时间桶 |
| `hour` | 按小时对齐的时间桶 |
| `day` | 按天对齐的时间桶 |
| `direction` | 出站 / 入站 / 混合 |
| `app` | 应用 ID（走明细表聚合） |

> 当 `groupBy` 包含 `app` 或指定了 `appId` 时，聚合直接基于明细表计算，不走分钟聚合桶。

## 便捷聚合方法

```javascript
// 按对端聚合
const peerTotals = await user.traffic.getPeerTotals();

// 按服务器聚合
const serverTotals = await user.traffic.getServerTotals();

// 时间线（默认按分钟）
const timeline = await user.traffic.getTimeline();

// 按小时时间线
const hourly = await user.traffic.getTimeline({ groupBy: "hour" });

// 总体统计
const total = await user.traffic.getTotalStats();
console.log(total.countOut, total.bytesOut, total.countIn, total.bytesIn, total.countFail);
```

## 计数与存储信息

```javascript
// 总条数
const totalCount = await user.traffic.count();

// 按条件计数
const appCount = await user.traffic.count({ category: "app" });

// 获取存储元信息
const info = await user.traffic.getStorageInfo();
console.log(info.entryCount);   // 明细记录数
console.log(info.aggCount);     // 聚合桶数
console.log(info.oldestTs);     // 最早记录时间
console.log(info.newestTs);     // 最晚记录时间
```

## 删除与清理

```javascript
// 删除指定时间之前的所有记录
const deleted = await user.traffic.deleteBefore(Date.now() - 7 * 24 * 60 * 60 * 1000);
console.log(deleted.entriesDeleted, deleted.aggsDeleted);

// 按条件删除
await user.traffic.delete({ peerUserId: "xxx" });
await user.traffic.delete({ category: "latency", toTs: Date.now() - 60 * 1000 });

// 清空全部流量数据（包括未刷盘队列）
await user.traffic.clearAll();
```

> `deleteUser(namespace, { skipConfirm: true })` 在删除用户数据库前会自动 `traffic.setEnabled(false)` + `server.disconnectAll()` + `traffic.flush()`，避免后台埋点导致 IndexedDB `deleteDatabase` 被阻塞。
