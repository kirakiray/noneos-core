# nos/peer（Stage 1 / Stage 2 / Stage 4）

5.0 用户互联重写：传输无关的 `PeerSession` + Relay 多路复用 + SharedWorker Hub + leader 标签页 RTC。

## 文件

| 文件 | 作用 |
|---|---|
| `framing.js` | 16 字节二进制帧（version/type/flags/seq/ack/length） |
| `reorder-buffer.js` | 接收端重排、去重、窗口控制 |
| `outbox.js` | 发送端未确认队列（当前内存实现） |
| `session.js` | `PeerSession`：seq/ACK/重传/交付 |
| `links/fake-link.js` | 内存双端链路，供测试使用 |
| `relay/mux.js` | 一条 Relay 连接上按 from/to 复用多个 peer 帧 |
| `relay/websocket-transport.js` | WebSocket 二进制传输（WebTransport 后续实现同一接口） |
| `hub/hub.js` | `PeerHub`：SharedWorker 内的 PeerSession、标签页广播、可选 E2EE |
| `hub/shared-worker.js` | SharedWorker 入口 |
| `hub/client.js` | 页面侧 `PeerHubClient`（MessagePort RPC + leader RTC 绑定） |
| `hub/rtc-proxy-link.js` | SharedWorker 内把帧代理给 leader 标签页 |
| `rtc/leader.js` | leader 标签页内的 RTC：每个 peer 一个 RTCPeerConnection、DataChannel、SDP/ICE |
| `identity.js` | ECDSA P-256 身份；`userId = SHA-256(publicKey)` |
| `auth.js` | 连接认证：签名服务端 challenge，`ready` 后才建立 mux |
| `e2ee.js` | ECDH + AES-GCM payload 加密 |
| `public-keys.js` | 已认证连接上的公钥查询 |
| `services.js` | appId 服务注册/发现 |
| `identity-store.js` | 身份持久化（nos/storage） |
| `e2ee.js` | 基于身份密钥的 ECDH + AES-GCM payload 加密 |
| `public-keys.js` | 通过已认证连接查询远端公钥（服务端文本控制帧） |

## API

```js
import { PeerSession } from "/nos/peer/session.js";
import { createFakeLinkPair } from "/nos/peer/links/fake-link.js";

const [a, b] = createFakeLinkPair();
const sender = new PeerSession({ link: a }).start();
const receiver = new PeerSession({ link: b }).start();

receiver.onMessage((payload, { seq }) => console.log(seq, payload));
await sender.send(new TextEncoder().encode("hello"));
```

`send(data, { reliable })`：可靠消息返回的 Promise 在对端 ACK 后 resolve；`reliable:false` 只保证交给链路。
`replaceLink(link)`：切换底层链路，并按原 seq 重发所有未确认消息；接收端按 seq 去重。

## Hub（Stage 2）

```js
import { PeerHubClient } from "/nos/peer/hub/client.js";

const identity = await createIdentity();
const hub = new PeerHubClient();
await hub.connect({ url: "ws://localhost:8081", identity });
hub.onMessage((payload, { peerId, seq }) => console.log(peerId, seq, payload));
await hub.send("bob", new TextEncoder().encode("hello"));
```

SharedWorker 会自动在 URL 上补 `?userId=`；一个页面只创建一个 hub 客户端。

## 测试

```bash
node --test tests/peer/*.node.test.mjs
# 或 npm run test:peer
```
