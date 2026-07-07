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

### 挂载真实本地目录 (仅 Chrome)
```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open(); // 用户选择本地文件夹
await mount(handle);        // 挂载到系统，路径变为 $mount-xxx>目录名
```

更多详细操作参考：[文件系统 API 参考](references/fs-api.md)

> ⚠️ **搭配 ofa.js 使用注意**：NoneOS 返回的 handle、`LocalUser`、`RemoteUser`、`DataPublisher`、`AppManager` 等均为类实例/复杂对象，属于 ofa.js 的**非响应式数据**。将其挂载到 ofa.js 组件的 `this` 上时，变量名必须以 `_` 开头（例如 `this._handle`、`this._user`、`this._publisher`），以避免被响应式系统转换，从而防止运行异常与性能问题。

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

更多参考：[DataPublisher 完整文档](/nos/publish/README.md) | [测试用例](/tests/publish/data-publisher.sb.html)

## 核心功能 4：应用发布与管理 (AppManager)

基于 DataPublisher 的应用发布管理模块，提供应用的创建、发布、发现、安装、升级、下架和推荐机制。

```javascript
import { AppManager } from "/nos/publish/app-manager.js";

const user = await getUser("my-ns");
const manager = new AppManager(user);
manager.start();

// 发布应用（两步：预览 → 确认发布）
const handle = await init("my-app");
const release = await manager.createRelease(handle, {
  appName: "my-app",
  version: "0.1.0",
});
// UI 展示 release 信息给用户确认
const { appId } = await manager.publish(release);

// 安装他人应用
const manifest = await manager.fetchManifest(appId);
await manager.installApp(manifest);

// 通过 /$apps/{appName}-{appId}/ 访问已安装的应用

// 检查更新
const update = await manager.checkForUpdates(appId);
if (update?.hasUpdate) {
  await manager.installApp(update.manifest);
}
```

更多参考：[AppManager API 参考](references/app-manager.md)

更多详细操作参考：
- [用户管理 API 参考](references/user-api.md)
- [LocalUser 基础](references/local-user.md) — 创建、初始化、持久化与签名验证
- [用户信息管理](references/user-info.md) — 信息获取、更新、合并与验证
- [证书管理](references/user-cert.md) — 证书签发、导入、查询与安全管理
- [用户导出/导入/删除](references/user-export-import.md) — 加密导出、导入、生命周期管理

### 服务器连接

- [服务器连接与握手](references/connect-server.md) — 连接、安全握手、延迟测量
- [服务器列表管理](references/server-list.md) — 默认列表、添加/删除、持久化

### 通信详细操作

- [用户连接与通信](references/connect-user.md) — 连接远程用户、发送/接收消息、名片交换、E2EE 加密
- [通过服务器代理数据通信](references/agent-data.md) — 查询在线状态、转发数据与二进制传输

---

## 其他参考

- [AI 操作文档](references/ai.md)
- [安装系统的组件文档 (nos-version)](references/nos-version.md)
- [图标组件文档 (n-icon)](references/n-icon.md)
- [代码风格规范](references/fs-api.md#代码风格规范)
