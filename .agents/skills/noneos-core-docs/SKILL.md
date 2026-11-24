# NoneOS Core 核心文档

NoneOS Core 是基于浏览器的虚拟操作系统内核，提供**虚拟文件系统**和 **Peer 用户互联**两大能力。

## 安装

```html
<script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js@5/dist/ofa.min.js"></script>
<l-m src="https://core.noneos.com/nos-lib/nos-version/nos-version.html"></l-m>
<nos-version auto-install></nos-version>
<script type="module">
  $("nos-version").on("installed", () => console.log("NoneOS Core 已就绪"));
</script>
```

参考：[nos-version](references/nos-version.md) | [根证书与密钥轮换](references/root-cert.md)

---

## 核心功能 1：挂载文件系统

```js
import { init, get } from "/nos/fs/main.js";

await init("my-app");
const file = await get("my-app/index.html", { create: "file" });
await file.write("<h1>Hello NoneOS</h1>");
```

挂载后通过 `/$my-app/index.html` 访问；CDN 资源可用 `/gh/...` 简写。

```js
import { open, mount } from "/nos/fs/main.js";
const handle = await open();
await mount(handle);
```

详细：[文件系统 API](references/fs-api.md)

---

## 核心功能 2：Peer 用户互联（5.0 重写）

5.0 使用 `PeerSession + Link`：FakeLink → WS Relay → RTC DataChannel，SharedWorker 负责多标签页共享。

### 身份

```js
import { createIdentity } from "/nos/peer/identity.js";
const identity = await createIdentity();
console.log(identity.userId); // sha256(publicKey)
```

SharedWorker 会自动通过 `nos/storage` 持久化身份；应用通常不需要手动创建。

### 推荐入口：PeerHubClient

```js
import { PeerHubClient } from "/nos/peer/hub/client.js";

const hub = new PeerHubClient();
await hub.connect({ url: "ws://localhost:8081" });

hub.onMessage((payload, { peerId, seq }) => {
  console.log(peerId, seq, new TextDecoder().decode(payload));
});

await hub.send(remoteUserId, new TextEncoder().encode("hello"));
```

- 自动完成 ECDSA 挑战应答
- 所有标签页共享一条 Relay WS 和同一身份
- 自动尝试 RTC 直连，失败回退 WS
- 可选 E2EE（身份 + 公钥解析）

### 服务发现

```js
await hub.registerServices(["chat-v1"]);
const userIds = await hub.lookupService("chat-v1");
```

### 低层 API

`PeerSession` 独立于传输，提供序号、累计 ACK、重传、乱序缓冲和去重；`RelayMux` 在一条 WS 上按 `from/to` 复用多个 peer。

```js
import { PeerSession } from "/nos/peer/session.js";
const session = new PeerSession({ link }).start();
await session.send(bytes);
session.replaceLink(nextLink);
```

完整说明：[Peer 互联 API](references/peer.md)

### 服务端

```bash
npm run relay -- --port 8081
npm run relay -- --port 8081 --mailbox ./mailbox.json
npm run test:relay
```

Rust 服务端 `server/relay/`：WS 中继、挑战应答认证、公钥查询、服务发现、离线信箱。

---

## 核心功能 3：本地数据存储

```js
import { storage, getStorage } from "/nos/storage/main.js";

await storage.setItem("settings", { theme: "dark" });
const settings = await storage.getItem("settings");

const appStore = getStorage("my-app");
await appStore.setItem("token", "abc");
```

支持复杂类型、nos/fs 文件句柄、跨标签页同步。详细：[storage](references/storage.md)

> 5.0 不再提供 `LocalUser.getStorage()` / `RemoteUser.getStorage()` 的用户隔离与远端共享；需要时在应用层自行按 `userId` 建独立 `getStorage(id)` 空间。

---

## 其他参考

- [Peer 互联 API](references/peer.md)
- [storage](references/storage.md)
- [nos-version](references/nos-version.md)
- [根证书与密钥轮换](references/root-cert.md)
- [n-icon](references/n-icon.md)
- [nos-lib](references/nos-lib.md)
- [locale-text](references/locale-text.md)
- [代码风格规范](references/fs-api.md#代码风格规范)
