# 应用层可靠消息投递（ACK + 重发 + 去重）

> 适用于所有基于 `registerService` / `sendToService` 的应用通信。**这是使用规范，不是框架自带能力**——`nos/user` 只保证「尽力投递」，业务侧必须自己实现确认与重发。

## 为什么需要

`sendToService` 是一次性的单向投递，返回的 `status: "ok"` 只代表**本端成功把数据交给了传输通道**，不代表对端 handler 真的执行了。以下场景消息会静默丢失：

| 场景 | 现象 |
|------|------|
| RTC 通道正在切换 / 刚断开 | 数据写入了一个即将失效的 DataChannel，返回 `ok` 但对端收不到 |
| 对端标签页刷新或关闭 | `serviceSessionCache`（TTL 30s）尚未失效，仍投递到已消失的 session |
| 对端应用启动窗口期 | 对端已在线但还未 `registerService`，消息触发 `unhandled_service_message` 后被丢弃 |
| 中继服务器切换 / 重连 | 重连期间发出的消息可能丢失 |
| 对端 handler 内部抛错 | `#dispatchToServiceApp` 只 `console.warn`，发送方完全无感知 |

> 补充说明：WebRTC DataChannel 本身以 `ordered: true` 创建，SCTP 层是可靠有序传输，单条消息在**通道存活期间**不会丢字节；真正的丢失来自上表的**通道切换与端点消失**，以及双通道（RTC / 中继）并存导致的时序问题。因此应用层 ACK 依然是必需的。

## 标准做法

### 五个要素

1. **每条消息带唯一 `msgId`**，由发送方生成
2. **接收方必须回 ACK**，发送方在超时时间内没收到就重发
3. **接收方按 `msgId` 去重**，重发导致的重复消息只处理一次
4. **单条消息必须小于 256KB**，超过则拆分成多条依次发送
5. **同一目标串行发送**，上一条收到 ACK 后才发下一条，禁止并行灌入

### 消息格式约定

在业务数据外再包一层信封，与 `__app` / `__data` 的框架层包裹互不干扰：

```javascript
// 业务消息
{ msgId: "m-1712049...-3", kind: "data", payload: { /* 真正的业务数据 */ } }

// 确认消息
{ msgId: "m-1712049...-3", kind: "ack" }
```

### 单条消息大小限制：必须 < 256KB

这是**服务端硬限制**，不是建议值。中继服务器对两类消息都有上限校验（见 `server/handshake/src/config.rs`）：

| 配置项 | 默认值 | 作用 |
|--------|--------|------|
| `text_message_max_size` | 256KB | 文本（JSON）消息上限 |
| `binary_payload_max_size` | 256KB | 二进制 relay 帧 payload 上限 |
| `handshake_max_size` | 1KB | 握手响应上限 |

超限时服务端**直接拒绝并回错误**，不会中继。更麻烦的是：E2EE 加密与 JSON 序列化都会让实际字节数大于业务数据的原始体积，所以要留足余量。实践上把业务 payload 控制在 **128KB** 以内最稳妥（这也是 `nos/publish` 的 `CHUNK_SIZE`）。

发送前做一次前置校验，避免白跑一轮重试。字节数测量可直接复用 `nos/user/traffic.js` 已导出的 `measureSize`（已覆盖 string / ArrayBuffer / TypedArray / Blob / 纯对象）：

```javascript
import { measureSize } from "/nos/user/traffic.js";

const MAX_PAYLOAD = 128 * 1024; // 安全上限，为加密与序列化开销留余量

function assertSendable(payload) {
  const size = measureSize(payload);
  if (size > MAX_PAYLOAD) {
    throw new Error(`payload too large: ${size} bytes (max ${MAX_PAYLOAD})`);
  }
  return size;
}
```

**超过限制怎么办**：

- 传文件 / 大 Blob → 直接用 [nos/publish](https://raw.githubusercontent.com/kirakiray/noneos-core/refs/heads/main/nos/publish/README.md)，它已内置 128KB 分块、哈希校验、超时重试与并发上限（8），不要自己拆
- 业务上确实是一条大 JSON → 自己拆成多条带 `seq` / `total` 的分片消息，每片独立 ACK，接收方按 `msgId` 前缀聚合后再交给业务

### 串行发送队列：一条一 ACK，不并行

**禁止对同一目标并行 `sendToService`**。原因：

- 每条消息都在等 ACK 且各自带重发定时器，并行会让重发风暴叠加，瞬间打满中继流量
- 服务端有 `relay_fail_limit`（默认 10 次/窗口）失败熔断，并行失败会更快触发
- RTC DataChannel 的发送缓冲区被灌满后会开始丢弃或阻塞，反而加剧丢包
- 消息顺序不可控，业务侧要额外处理乱序

按 `userId + sessionId` 维度维护串行队列，前一条 ACK 到达（或彻底失败）后才发下一条：

```javascript
// 队列 key -> 尾部 Promise，形成串行链
const sendQueues = new Map();

/**
 * 把发送操作排入对应目标的串行队列
 * @param {string} key - 队列标识，建议 `${userId}:${sessionId ?? "all"}`
 * @param {() => Promise<void>} task
 */
function enqueue(key, task) {
  const prev = sendQueues.get(key) ?? Promise.resolve();
  // 用 catch 兜住前一个任务的失败，避免整条队列断裂
  const next = prev.then(task, task);
  sendQueues.set(key, next);

  // 队列排空后清理，防止 Map 无限增长
  next.finally(() => {
    if (sendQueues.get(key) === next) sendQueues.delete(key);
  });

  return next;
}

/** 对外接口：大小校验 + 排队 + 等 ACK */
function sendQueued(remoteUser, appId, payload, sessionId) {
  assertSendable(payload);
  const key = `${remoteUser.userId}:${sessionId ?? "all"}`;
  return enqueue(key, () => sendReliable(remoteUser, appId, payload, sessionId));
}
```

批量发送时天然变成逐条投递，无需额外处理：

```javascript
for (const item of items) {
  await sendQueued(remoteUser, "chat-v1", item, ctx.fromSessionId);
}
```

> **不同目标之间可以并行**：队列按目标划分，发给 A 和发给 B 互不阻塞。若确实需要提升单目标吞吐，可以放宽到「最多 N 条在途」（滑动窗口），但**必须有上限**，建议 N ≤ 8，且每条仍各自 ACK 与去重。

> **框架内的既有实践**：`nos/publish` 的 `fetchFile` 拉取多个 chunk 时，使用 `asyncPool`（`nos/util/async-pool.js`）把在途请求限制在 `CHUNK_FETCH_CONCURRENCY = 8`。需要并发上限时可直接复用这个工具，不必自己写调度：
>
> ```javascript
> import { asyncPool } from "/nos/util/async-pool.js";
>
> await asyncPool(items, (item) => sendReliable(remoteUser, appId, item), 8);
> ```

### 发送方：带超时重发

```javascript
const ACK_TIMEOUT = 3000;   // 单次等待 ACK 的毫秒数
const MAX_RETRY = 3;        // 最大重发次数

const pendingAcks = new Map(); // msgId -> { resolve, reject, timer, tries }
let msgSeq = 0;

/**
 * 发送一条需要对方确认的消息
 * @param {import("/nos/user/remote-user.js").RemoteUser} remoteUser
 * @param {string} appId
 * @param {*} payload - 业务数据
 * @param {string} [sessionId] - 定向发送时传入
 * @returns {Promise<void>} ACK 到达时 resolve，重试耗尽时 reject
 */
function sendReliable(remoteUser, appId, payload, sessionId) {
  const msgId = `m-${Date.now()}-${++msgSeq}`;

  return new Promise((resolve, reject) => {
    const entry = { resolve, reject, timer: null, tries: 0 };
    pendingAcks.set(msgId, entry);

    const attempt = async () => {
      entry.tries++;
      if (entry.tries > MAX_RETRY) {
        pendingAcks.delete(msgId);
        reject(new Error(`ACK timeout after ${MAX_RETRY} retries: ${msgId}`));
        return;
      }

      // 重发时复用同一个 msgId，接收方据此去重
      const results = await remoteUser.sendToService(
        appId,
        { msgId, kind: "data", payload },
        sessionId ? { sessionId } : { waitForService: ACK_TIMEOUT },
      );

      // 连通道都没进去（no_receiver / offline / error），直接进入下一轮重试
      if (!results.some((r) => r.status === "ok")) {
        entry.timer = setTimeout(attempt, ACK_TIMEOUT);
        return;
      }

      entry.timer = setTimeout(attempt, ACK_TIMEOUT);
    };

    attempt();
  });
}

/** 收到 ACK 时结算 */
function resolveAck(msgId) {
  const entry = pendingAcks.get(msgId);
  if (!entry) return; // 迟到的重复 ACK，忽略
  clearTimeout(entry.timer);
  pendingAcks.delete(msgId);
  entry.resolve();
}
```

### 接收方：去重 + 回 ACK

```javascript
const seenIds = new Map(); // msgId -> 首次接收时间戳
const SEEN_TTL = 5 * 60 * 1000; // 去重记录保留 5 分钟

user.registerService("chat-v1", {
  async onMessage(data, ctx) {
    if (!data || !data.msgId) return; // 不符合协议的消息忽略

    // 1. ACK 分支：结算本端等待中的发送
    if (data.kind === "ack") {
      resolveAck(data.msgId);
      return;
    }

    // 2. 无论是否重复，都必须先回 ACK
    //    （重复消息说明上一次 ACK 丢了，必须再回一次，否则对端会一直重发）
    ctx.remoteUser
      .sendToService("chat-v1", { msgId: data.msgId, kind: "ack" }, {
        sessionId: ctx.fromSessionId, // 定向回复，避免广播到对端所有标签页
      })
      .catch(() => {});

    // 3. 去重：同一 msgId 只处理一次业务逻辑
    if (seenIds.has(data.msgId)) return;
    seenIds.set(data.msgId, Date.now());
    pruneSeen();

    // 4. 执行业务逻辑
    handleBusiness(data.payload, ctx);
  },
});

/** 清理过期的去重记录，避免 Map 无限增长 */
function pruneSeen() {
  const deadline = Date.now() - SEEN_TTL;
  for (const [id, ts] of seenIds) {
    if (ts < deadline) seenIds.delete(id);
  }
}
```

## 关键细节

### 1. ACK 必须在去重判断**之前**发出

顺序写错是最常见的 bug：如果先判重再回 ACK，那么「业务已执行但 ACK 丢失」的消息在重发时会被去重逻辑直接吞掉，不再回 ACK，发送方就会一直重试到耗尽。

### 2. 回 ACK 一定要带 `sessionId`

用 `ctx.fromSessionId` 定向回复。不传 `sessionId` 会重新走一遍服务发现并广播到对端**所有**注册了该 appId 的标签页，既浪费流量，也会让其它标签页的 `pendingAcks` 收到不属于自己的 ACK。

### 3. 重发必须复用同一个 `msgId`

`msgId` 是去重的唯一依据。重发时生成新 id 等于关掉了去重，对端会重复执行业务逻辑。

### 4. 业务逻辑应尽量幂等

去重记录只在内存中，标签页刷新后即失效。对于「扣款」「计数」这类不可重复执行的操作，除了 msgId 去重外，业务本身也应能容忍重放（例如以 msgId 作为业务主键写入 [storage](storage.md)，或用 `nos/storage` 持久化 `seenIds`）。

### 5. 超时时间参考实际 RTT

固定 3000ms 只是保守默认值。可以用 `remoteUser.getRTT()` 拿到当前链路延迟动态调整：

```javascript
const info = remoteUser.getRTT(sessionId);
// 至少 1500ms，或 RTT 的 8 倍
const timeout = Math.max(1500, (info?.rtt ?? 200) * 8);
```

注意 `getRTT()` 返回的 `via` 是 `"rtc"` 还是 `"server"`——刚从 RTC 降级到中继时延迟会明显上升，此时不宜用过短的超时。

### 6. 首发建议配合 `waitForService`

对端应用可能还没 `registerService`。第一次发送时带上 `waitForService`，可以避免立刻拿到 `no_receiver` 而空耗一轮重试。

### 7. 去重表要有上限

`seenIds` 必须做 TTL 或容量清理（上例为 5 分钟），否则长时间运行的应用会持续泄漏内存。

### 8. 重试耗尽后交给业务决策

`sendReliable` reject 之后不要静默丢弃。典型处理：写入本地待发队列（用 [storage](storage.md) 持久化），等 `remote_user_connected` 事件重新触发时补发。

### 9. 大小校验放在入队之前

`assertSendable` 应在排队**之前**抛错，让调用方立刻知道数据超标，而不是排到队首才失败、白占一个队列位。

### 10. ACK 不要进发送队列

接收方回 ACK 时直接 `sendToService`，**不要走串行队列**。ACK 本身不需要确认，若把它排入队列，会与正在等待 ACK 的数据消息形成死锁（队首等 ACK，ACK 排在队尾发不出去）。

### 11. 队列积压要有上限

长时间离线时队列会无限增长。建议记录队列长度，超过阈值（如 100 条）时拒绝新的发送请求或丢弃最旧的低优先级消息，并向用户暴露状态。

## 完整调用示例

```javascript
// 发送方：逐条串行投递，每条都等对方确认
const remote = await user.connectUser(targetUserId);
for (const item of items) {
  try {
    await sendQueued(remote, "chat-v1", item);   // 大小校验 → 排队 → 等 ACK
  } catch (err) {
    console.warn("投递失败，转入待发队列：", err.message);
    await pendingStore.setItem(`retry-${Date.now()}`, item);
  }
}
```

## 何时不需要这套机制

| 场景 | 建议 |
|------|------|
| 传输文件 / 大 Blob | 用 [nos/publish](https://raw.githubusercontent.com/kirakiray/noneos-core/refs/heads/main/nos/publish/README.md)，它已内置内容寻址、分块校验、超时重试，比手写 ACK 更可靠 |
| 高频状态同步（如光标位置、在线心跳） | 丢一帧无影响，加 ACK 反而放大流量；用「最新值覆盖 + 定期全量同步」代替 |
| 同设备跨标签页共享数据 | 用 [nos/storage](storage.md)，其 BroadcastChannel 同步不经过网络，不存在丢失问题 |
| 纯 RTT 测量 | 直接用内置的 `remoteUser.ping(sessionId)`，它已有 pendingPings 配对与超时 |

## 相关文档

- [用户连接与通信](connect-user.md) — `sendToService` 的状态语义、服务发现与缓存机制
- [storage 存储模块](storage.md) — 持久化待发队列与去重记录
- [客户端流量统计](traffic.md) — 观察重发导致的实际流量开销
