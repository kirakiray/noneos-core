# Peer 互联 API（5.0）

5.0 用 `PeerSession + Link` 重写用户互联，旧的 `nos/user`、`nos/publish`、`server/handshake` 已移除。

## 分层

```text
PeerSession（可靠序号/ACK/重传/去重，传输无关）
  ├─ FakeLink（测试）
  ├─ WsRelayLink（RelayMux 按 from/to 复用一条 WS）
  ├─ RtcProxyLink（SharedWorker 代理给 leader 标签页）
  └─ Rtc DataChannel（leader 标签页直接连接）
```

- SharedWorker 持有 PeerSession + Relay WS；RTC 只能在 Window，所以由 leader 标签页持有。
- 一条 WS 承载所有 peer；服务端按 mux 帧 `from/to` 路由。
- 没有 TURN；RTC 失败自动留在 WS。

## 身份

```js
import { createIdentity } from "/nos/peer/identity.js";

const identity = await createIdentity();
// identity.userId  = SHA-256(publicKey base64) hex
// identity.publicKey / identity.privateKey（base64）
const signature = await identity.sign("message");
```

持久化（SharedWorker 自动使用）：

```js
import { loadOrCreateIdentity } from "/nos/peer/identity-store.js";
const identity = await loadOrCreateIdentity();
```

身份保存在 `nos/storage` 的 `nos-peer-identity` 空间，私钥只在本机。

## Hub 客户端（应用推荐入口）

```js
import { PeerHubClient } from "/nos/peer/hub/client.js";

const hub = new PeerHubClient(); // 默认 /nos/peer/hub/shared-worker.js
await hub.connect({ url: "ws://localhost:8081" });
console.log(hub.userId);

hub.onMessage((payload, { peerId, seq }) => {
  console.log(peerId, seq, new TextDecoder().decode(payload));
});

await hub.send(remoteUserId, new TextEncoder().encode("hello"));

// 服务发现
await hub.registerServices(["chat-v1"]);
const users = await hub.lookupService("chat-v1");
```

- `connect` 会自动加载/生成身份、完成 ECDSA 挑战应答，再建立 SharedWorker。
- 每个页面创建一个客户端；所有标签页共享同一条 WS 和身份。
- 传入 `identity` 可覆盖默认身份。

## 低层 PeerSession

```js
import { PeerSession } from "/nos/peer/session.js";
import { RelayMux } from "/nos/peer/relay/mux.js";
import { WebSocketTransport } from "/nos/peer/relay/websocket-transport.js";
import { authenticateTransport } from "/nos/peer/auth.js";

const transport = new WebSocketTransport("ws://localhost:8081");
await transport.connect();
await authenticateTransport({ transport, identity });

const mux = new RelayMux({ transport, localId: identity.userId });
const session = new PeerSession({ link: mux.link(remoteUserId) }).start();

const result = await session.send(bytes); // { seq, acked, attempts }
session.onMessage((payload, meta) => {});
session.replaceLink(nextLink); // 换链路时重发未确认消息
session.close();
```

`send` 默认可靠；ACK 超时重传 `maxRetries` 次。`ReorderBuffer` 负责乱序/去重。

## 服务端

```bash
npm run relay -- --port 8081
# 持久化离线信箱
npm run relay -- --port 8081 --mailbox ./mailbox.json
npm run test:relay
```

- 连接后先做 ECDSA 挑战应答；服务端校验 `userId == sha256(publicKey)`。
- 公钥查询 / 服务发现使用文本控制帧。
- 离线信箱默认内存，`--mailbox` 使用 JSON 文件持久化。

## E2EE

```js
import { createCodec } from "/nos/peer/e2ee.js";
const codec = await createCodec({ localIdentity, remotePublicKey });
const ciphertext = await codec.encode(bytes);
const plaintext = await codec.decode(ciphertext);
```

Hub 配置了身份和 `resolvePublicKey` 时会自动加密 app/控制 payload；公钥通过服务端 `lookup` 查询。

## 限制

- 真实 RTC/SharedWorker 需要浏览器环境；Node 测试使用 FakeLink/fake RTCPeerConnection。
- 没有 TURN；RTC 失败回退 WS。
- 没有应用层 profile（用户名/头像）；组件层只显示 userId。
