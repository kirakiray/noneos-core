---
name: "noneos-core-docs"
description: "提供 NoneOS Core 文件系统与用户管理文档，涵盖安装、文件系统挂载、用户联机与服务通信。当用户询问 NoneOS Core 使用方法、挂载静态文件或实现应用联机功能时调用。"
---

# NoneOS Core 核心文档

NoneOS Core 是一个基于浏览器的虚拟操作系统内核，主要提供**虚拟文件系统**和**用户联机通信**两大核心功能，帮助开发者快速构建去中心化的网页应用。

## 安装

### 1. 创建 Service Worker 文件
在根目录创建 `sw.js`：
```javascript
importScripts("https://core.noneos.com/sw/dist.js");
```

### 2. 入口 HTML 安装
```html
<script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js"></script>
<l-m src="https://core.noneos.com/nos-tool/comps/nos-version.html"></l-m>
<nos-version auto-install></nos-version>

<script type="module">
  $("nos-version").on("installed", () => {
    console.log("NoneOS Core 已就绪");
  });
</script>
```
参考：[nos-version 组件文档](references/nos-version.md)

---

## 核心功能 1：挂载文件系统 (静态文件托管)

NoneOS Core 可以将虚拟目录或本地目录挂载到网页中，使其像访问普通静态文件一样被引用。

### 初始化与获取文件
```javascript
import { init, get } from "/nos/fs/main.js";

// 初始化应用根目录
await init("my-app");

// 获取或创建文件
const file = await get("my-app/index.html", { create: "file" });
await file.write("<h1>Hello NoneOS</h1>");
```

### 通过 HTTP 访问与预览
挂载后的文件可以通过 `/$目录名/路径` 的形式直接访问：
```javascript
// 在网页中引用挂载的文件
const content = await fetch("/$my-app/index.html").then(res => res.text());

// 或者在浏览器地址栏输入：http://localhost:xxxx/$my-app/index.html 即可直接预览
```

### 资源访问优化 (CDN 简写)

NoneOS Core 提供了对 `cdn.jsdelivr.net` 资源的访问优化。当 NoneOS Core 初始化完成后，你可以省略域名直接通过 `/gh/` 等路径访问资源。这些资源会由系统自动拦截并持久化缓存到本地，提升二次加载速度。

```javascript
// 传统访问方式
fetch("https://cdn.jsdelivr.net/gh/ofajs/ofa.js/dist/ofa.js");

// 优化后的简写访问方式 (仅在 NoneOS Core 初始化后有效)
fetch("/gh/ofajs/ofa.js/dist/ofa.js");
```

### 挂载真实本地目录 (仅 Chrome)
```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open(); // 用户选择本地文件夹
await mount(handle);        // 挂载到系统，路径变为 $mount-xxx>目录名
```

更多详细操作参考：[文件系统 API 参考](references/fs-api.md)

> ⚠️ **搭配 ofa.js 使用注意**：NoneOS 返回的 handle、`LocalUser`、`RemoteUser`、`DataPublisher` 等均为类实例/复杂对象，属于 ofa.js 的**非响应式数据**。将其挂载到 ofa.js 组件的 `this` 上时，变量名必须以 `_` 开头（例如 `this._handle`、`this._user`、`this._publisher`），以避免被响应式系统转换，从而防止运行异常与性能问题。

---

## 核心功能 2：用户联机与服务通信

NoneOS Core 提供基于身份标识 (userId) 的端到端通信功能，支持 WebRTC 直连和服务器中转。

### 获取用户
```javascript
import { getUser } from "/nos/user/main.js";

const user = await getUser("my-app-namespace");
console.log("我的 ID:", user.userId);
```

### 注册应用服务 (Service)
应用服务让你可以以 `appId` 为单位进行通信，自动处理路由。
```javascript
const svc = user.registerService("chat-v1", {
  onMessage(data, ctx) {
    console.log(`收到来自 ${ctx.fromUserId} 的消息:`, data);
    // 回复消息
    ctx.remoteUser.send(ctx.fromSessionId, { msg: "已收到" });
  },
});
```

### 发送消息到对方应用
```javascript
const remoteUser = await user.connectUser(targetUserId);

// 发送到对方注册了 "chat-v1" 的所有标签页
await remoteUser.sendToService("chat-v1", {
  text: "你好，联机系统！",
});
```

> ⚠️ **可靠投递规范**：`sendToService` 只保证「尽力投递」，返回 `ok` 不代表对端 handler 已执行（RTC 通道切换、对端刷新、服务发现缓存过期等都会导致静默丢失）。**每个应用的发送操作都应做到：消息带唯一 msgId + 对方限时回 ACK + 超时重发 + 接收方按 msgId 去重 + 单条消息小于 256KB（服务端硬限制）+ 同一目标串行发送（收到 ACK 后才发下一条）**。完整实现见：[应用层可靠消息投递](references/reliable-messaging.md)

### 查看已连接的远程用户与状态事件

LocalUser 会缓存已建立通信的远程用户，并通过 `user.remoteUsers` 暴露，同时提供 `isRemoteUserOnline()`、`getRemoteUsers()` 与 `remote_user_connected` / `remote_user_disconnected` 事件。详见：

- [用户连接与通信](references/connect-user.md) — 连接、断开、消息收发与连接事件
- [LocalUser 基础](references/local-user.md) — `remoteUsers`、`isRemoteUserOnline`、`getRemoteUsers` 与事件详情

---

## 核心功能 3：文件发布与获取 (DataPublisher)

基于 LocalUser 的点对点文件分发模块，将文件分块签名后发布，其他用户可通过 userId 远程获取。

```javascript
import { DataPublisher } from "/nos/publish/data-publisher.js";

const user = await getUser("my-ns");
const publisher = new DataPublisher(user);
publisher.start();

// 发布文件
const file = new File(["..."], "photo.jpg");
const manifest = await publisher.publish(file);

// 请求他人文件（sessionId 可选，不传则自动获取）
const remoteUser = await user.connectUser(publisherUserId);
const manifest2 = await publisher.requestManifest(remoteUser, fileHash);
for (const chunkHash of manifest2.chunkHashes) {
  await publisher.requestChunk(remoteUser, chunkHash);
}
const result = await publisher.assembleFile(fileHash);
// result.blob, result.fileName, result.fileSize
```

更多参考：[DataPublisher 完整文档](https://raw.githubusercontent.com/kirakiray/noneos-core/refs/heads/main/nos/publish/README.md) | [测试用例](https://raw.githubusercontent.com/kirakiray/noneos-core/refs/heads/main/tests/publish/data-publisher.sb.html)

更多详细操作参考：
- [用户管理 API 参考](references/user-api.md)
- [LocalUser 基础](references/local-user.md) — 创建、初始化、持久化、签名验证与无实例验签（`verifyData`）
- [用户信息管理](references/user-info.md) — 信息获取、更新、合并与验证
- [证书管理](references/user-cert.md) — 证书签发、导入、查询与安全管理
- [用户导出/导入/删除](references/user-export-import.md) — 加密导出、导入、生命周期管理

### 服务器连接

- [服务器连接与握手](references/connect-server.md) — 连接、安全握手、延迟测量
- [服务器列表管理](references/server-list.md) — 默认列表、添加/删除、持久化

### 通信详细操作

- [用户连接与通信](references/connect-user.md) — 连接远程用户、发送/接收消息、名片交换、E2EE 加密
- [应用层可靠消息投递](references/reliable-messaging.md) — ACK 确认、超时重发、msgId 去重（应用通信必读规范）
- [通过服务器代理数据通信](references/agent-data.md) — 查询在线状态、转发数据与二进制传输

### 流量统计

- [客户端流量统计](references/traffic.md) — 埋点开关、明细/聚合查询、删除清理

---

## 核心功能 4：本地数据存储 (storage)

官方的异步键值存储模块，基于 IndexedDB，提供类 `localStorage` 的接口但容量远大于它，支持复杂数据类型与跨标签页同步。**涉及本地数据持久化时应优先使用本模块，而非原生 `localStorage`。**

```javascript
import { storage, getStorage } from "/nos/storage/main.js";

// 默认存储空间
await storage.setItem("user-settings", { theme: "dark", language: "cn" });
const settings = await storage.getItem("user-settings");

// 独立存储空间（不同业务隔离，同 id 复用实例）
const appStore = getStorage("my-app");
await appStore.setItem("token", "abc");
```

还可直接存取 `nos/fs` 文件句柄，读回来仍是可用的句柄实例：

```javascript
await storage.setItem("last-opened", fileHandle);
const handle = await storage.getItem("last-opened");
console.log(await handle.text());
```

### 用户专属存储（按用户隔离）

`getStorage(id)` 按**业务**隔离存储空间；若需要按**用户**隔离（每个本地用户拥有独立数据，其他用户不可见），请使用 `LocalUser.getStorage(name)`，而不是通过全局 storage 自行拼接键名：

```javascript
import { getUser } from "/nos/user/main.js";

const user = await getUser("my-app");

// 该用户专属的存储空间（name 可选，默认 "default"）
const settings = await user.getStorage("settings");
await settings.setItem("theme", "dark");
```

- 存储 id 为 `user:<namespace>:<userId>:<name>`，每个「本地用户 + 身份 + 子空间」对应独立 IndexedDB 数据库，天然隔离
- `getStorage(name)` 是 **async** 方法（内部先 `await ready()` 并登记到用户库）
- 调用 `deleteUser(namespace)` 删除用户时，会联动清理该用户通过 `getStorage()` 创建的全部专属存储
- 支持 `nos/storage` 全部能力：复杂类型、nos/fs 句柄、遍历、代理语法、跨标签页同步（仅同用户同名子空间内生效）

#### 与远端用户共享（只读）

若要让**远端用户**只读访问某个专属存储空间，用 `shareStorage()` 显式开放，且空间名必须以 `share:` 开头：

```javascript
// 本地用户开放共享（只读，仅 share: 前缀空间可被共享）
const revoke = await user.shareStorage("share:settings");
// 随时关闭共享
await revoke();
```

- 仅 `share:` 开头的空间可被共享；其余存储远端无法访问
- **只读**：远端只能读取，不能写入
- `shareStorage(name)` 为 async，`name` 必须以 `share:` 开头，否则抛错
- 重复开启幂等；共享登记持久化，删除用户时随之清除
- 底层协议：远端发 `__storage_req`（`{reqId, name, op, key}`），接收端经三道防线校验（`share:` 前缀 → 已显式开启 → 只读白名单 `getItem/has/key/length/keys/entries`）后本地执行，回传 `__storage_resp`（`{reqId, ok, value}` 或 `{reqId, ok:false, error:{code, message}}`，错误码 `invalid_name / not_shared / read_only / internal`）

更多详细操作参考：[storage 存储模块](references/storage.md) | [LocalUser 基础](references/local-user.md)

---

## 其他参考

> ⚠️ **实验性特性**：`hybrid-data` 模块当前为实验性质，后续大概率迁移至新位置或被淘汰，请勿在正式项目中依赖。

- [storage 存储模块](references/storage.md)
- [宿主项目离线缓存 (host-cache)](references/host-cache.md)
- [安装系统的组件文档 (nos-version)](references/nos-version.md)
- [图标组件文档 (n-icon)](references/n-icon.md)
- [公共组件文档 (ncomp)](references/ncomp.md)
- [多语言模块 (locale-text)](references/locale-text.md)
- [代码风格规范](references/fs-api.md#代码风格规范)
