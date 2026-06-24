---
name: "noneos-core-docs"
description: "提供 NoneOS Core 文件系统与用户管理文档，涵盖安装、文件/目录操作、用户管理、证书与服务器连接。当用户询问 NoneOS Core 使用方法、文件系统操作或用户模块帮助时调用。"
---

# NoneOS Core 文件系统文档

NoneOS Core 是一个基于浏览器的虚拟文件系统，提供完整的文件和目录操作 API。

## 安装

### 前提条件

- 静态服务器（如 http-server、live-server、nginx 等）
- 浏览器支持 Service Worker
- 外网访问必须使用 HTTPS

### 1. 创建 Service Worker 文件

根目录创建 `sw.js`：

```javascript
importScripts("https://core.noneos.com/sw/dist.js");
```

### 2. 入口 HTML

```html
<!DOCTYPE html>
<html>
  <head>
    <script src="https://cdn.jsdelivr.net/gh/ofajs/ofa.js"></script>
  </head>
  <body>
    <l-m src="https://core.noneos.com/nos-tool/comps/nos-version.html"></l-m>
    <nos-version auto-install></nos-version>

    <script type="module">
      $("nos-version").on("installed", () => {
        console.log("NoneOS Core 安装完成");
      });
    </script>
  </body>
</html>
```

`nos-version` 组件会自动注册 `sw.js`。

### 安装状态

- **未安装**：显示 "Install NoneOS Core" 按钮
- **安装中**：显示进度条
- **已安装**：显示版本号
- **可升级**：显示升级按钮

触发 `installed` 事件后即可使用 NoneOS Core。

参考：[nos-version 组件文档](references/nos-version.md)

---

## 概述

### 全局 get 方法

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/hello.txt", { create: "file" });
const dir = await get("my-app/path/to/dir", { create: "dir" });
```

路径格式：`根目录名/文件路径`，不使用 `/` 开头。

### 初始化根目录

使用 `get` 访问根目录之前，必须先通过 `init` 初始化：

```javascript
import { init } from "/nos/fs/main.js";

const dir = await init("my-app");
```

这会创建一个根目录，之后就可以用 `get` 操作其中的文件：

```javascript
import { get } from "/nos/fs/main.js";

const file = await get("my-app/hello.txt", { create: "file" });
await file.write("Hello!");
```

### 句柄类型

- **FileHandle**：文件，提供读写操作
- **DirHandle**：目录，提供遍历和子项操作

### 基本属性

| 属性 | 描述 | 返回值 |
|------|------|--------|
| `kind` | 句柄类型 | `"file"` 或 `"dir"` |
| `name` | 名称 | 字符串 |
| `path` | 完整路径 | 字符串 |

---

## 文件操作

### 创建文件

```javascript
const file = await get("my-app/path/to/file.txt", { create: "file" });
```

### 写入文件

```javascript
await file.write("Hello, World!");
```

### 读取文件

| 方法 | 描述 |
|------|------|
| `text()` | 读取文本内容 |
| `file()` | 返回 File 对象 |
| `buffer()` | 返回 ArrayBuffer |
| `read({type, start, end})` | 底层读取 |

### JSON 操作

```javascript
const data = await file.json();
const base64String = await file.base64();
```

### 文件信息

```javascript
const timestamp = await file.lastModified();
const fileObj = await file.file();
console.log(fileObj.size);
```

### 通过 fetch 获取文件

```javascript
const content = await fetch("/$my-app/file1.txt").then((e) => e.text());
```

### 预览 HTML

```javascript
const htmlFile = await get("my-app/index.html", { create: "file" });
await htmlFile.write("<html><body><h1>Hello</h1></body></html>");
// 浏览器打开 /$my-app/index.html 预览
```

### 删除文件

```javascript
await file.remove();
```

---

## 目录操作

### 创建目录

```javascript
const dir = await get("my-app/path/to/dir", { create: "dir" });
```

### 获取子项数量

```javascript
const count = await dir.length();
```

### 遍历目录

| 方法 | 描述 |
|------|------|
| `keys()` | 遍历名称 |
| `values()` | 遍历句柄 |
| `entries()` | 遍历 [名称, 句柄] |
| `forEach(fn)` | 遍历 |
| `some(fn)` | 查找满足条件的第一个 |

```javascript
for await (const [name, handle] of dir.entries()) {
  console.log(`${handle.kind}: ${name}`);
}
```

### 扁平化目录

`flat()` 获取目录及所有子目录中的**文件句柄**：

```javascript
const allFiles = await dir.flat();
```

### 删除目录

⚠️ 会递归删除目录下所有内容，无法恢复。

```javascript
await dir.remove();
```

---

## 目录挂载

目录挂载功能允许访问用户本地文件系统中的**真实目录**，并将其持久化存储。

> **真实目录**：指您 Windows / macOS / Linux 系统上的实际文件夹，区别于虚拟文件系统中的目录。

### 重要说明

- `open()` 方法依赖于 `showDirectoryPicker` API，目前**仅 Chrome 浏览器完整支持**
- `mount()` 主要用于配合 `open()` 使用，将用户选择的本地目录持久化存储
- 对于通过 `init()` 创建的虚拟文件系统目录，不需要使用 `mount()`

### open() - 打开目录选择器

```javascript
import { open } from "/nos/fs/main.js";

const handle = await open();
```

弹出系统目录选择器，让用户选择一个本地目录。

### mount() - 挂载目录

```javascript
import { open, mount } from "/nos/fs/main.js";

const handle = await open(); // 打开目录选择器，此时 path 为虚拟路径
await mount(handle); // 挂载后，path 变为 $mount-{id}>目录名

console.log(handle.path); // 输出: $mount-123>目录名
```

挂载后的路径格式为：`$mount-{id}>目录名`

#### 两步流程的优势

推荐使用两步流程（先 `open()` 后 `mount()`），而不是一次性挂载：

1. **验证目录内容**：在挂载前可以先浏览目录内容，确认是否为所需目录
2. **避免错误挂载**：防止用户选错目录后，错误地挂载到系统中
3. **灵活决策**：可以根据目录内容决定是否挂载

```javascript
const handle = await open();

// 先验证目录内容
const packageJson = await handle.get("package.json");
const data = await packageJson.json();
if (data.somedata) {
  // 确认是符合条件的目录，再挂载
  await mount(handle);
  console.log("符合条件的目录已挂载:", handle.path);
} else {
  console.log("这是不符合条件的目录，取消挂载");
}
```

### 一次性打开并挂载

```javascript
const handle = await open({ mount: true });
```

### 获取已挂载目录列表

```javascript
import { getMounted } from "/nos/fs/main.js";

const mountedDirs = await getMounted();
mountedDirs.forEach(item => {
  console.log(item.id);        // 挂载ID
  console.log(item.name);      // 目录名称
  console.log(item.path);      // 挂载路径
  console.log(item.handle);    // DirHandle 对象
});
```

### 卸载目录

支持两种方式：

```javascript
import { unmount } from "/nos/fs/main.js";

// 方式 1：通过 ID 卸载
await unmount(mountId);

// 方式 2：通过 Handle 对象卸载（推荐）
await unmount(handle);
```

### 通过挂载路径访问文件

```javascript
import { get } from "/nos/fs/main.js";

// 假设已挂载的路径是 $mount-123>my-project
const file = await get("$mount-123>my-project/src/index.js");
const content = await file.text();
```

### 通过 HTTP 访问挂载文件

挂载后的目录可以通过 HTTP 请求访问，实现类似本地静态服务器的功能：

```javascript
const handle = await open({ mount: true });

// 通过 HTTP 访问本地文件
const response = await fetch(`/${handle.path}/index.html`);
const content = await response.text();
```

### 两种目录对比

| 特性 | 虚拟文件系统目录 | 本地目录（mount） |
|------|-----------------|------------------|
| 创建方式 | `init("dir-name")` | `open()` + `mount()` |
| 路径格式 | `$dir-name` | `$mount-{id}>dir-name` |
| HTTP 访问 | ✅ 直接支持 | ✅ 需要挂载后支持 |
| 持久化 | ✅ 自动持久化 | ✅ 需要 mount 持久化 |
| 数据位置 | 浏览器存储 | 用户本地文件系统 |
| 是否需要 mount | ❌ 不需要 | ✅ 需要 |
| 浏览器支持 | 所有现代浏览器 | 仅 Chrome |

### 浏览器兼容性

- ✅ **Chrome 86+ / Edge 86+** - 完整支持（推荐使用）
- ⚠️ **Firefox 111+** - 不支持 `showDirectoryPicker`，但可挂载虚拟目录
- ❌ **Safari** - 不支持 `showDirectoryPicker`，也不支持挂载虚拟目录

---

## 移动与复制

### 移动文件

```javascript
const movedFile = await sourceFile.moveTo(targetDir);
// 或指定新名称
const movedFile = await sourceFile.moveTo(targetDir, "newName.txt");
```

### 移动目录

递归移动目录及其所有内容。

### 复制文件

```javascript
const copiedFile = await sourceFile.copyTo(targetDir);
```

### 复制目录

递归复制目录及其所有内容。

---

## 句柄比较

### 获取父目录

```javascript
const parent = await file.parent;
```

### 获取根目录

```javascript
const root = file.root;
```

### 判断是否相同

```javascript
const isSame = await file1.isSame(file2);
```

### 获取文件大小

```javascript
const size = await file.size();
```

### 获取唯一标识符

```javascript
const id = await file.id();
```

### 句柄方法表

| 方法 | 描述 | 返回值 |
|------|------|--------|
| `isSame(target)` | 是否相同 | boolean |
| `size()` | 文件大小 | number \| null |
| `id()` | 唯一标识符 | string |
| `remove()` | 删除 | void |
| `copyTo(target, name)` | 复制 | FileHandle \| DirHandle |
| `moveTo(target, name)` | 移动 | FileHandle \| DirHandle |
| `observe(func)` | 监听变化 | () => void |

---

## 文件变化观察

文件和目录都可以监听变化。

### 基本用法

```javascript
const unobserve = await dir.observe((event) => {
  console.log("变化:", event.type, event.path);
});

await file.write("new content");
await file.remove();

unobserve();
```

### observe 返回值

返回取消观察的函数。

### 事件对象

| 属性 | 描述 |
|------|------|
| `type` | 事件类型：`"create"`, `"remove"`, `"write"` |
| `path` | 变化的文件路径 |

### 注意事项

1. 观察创建后才会开始监听
2. 取消观察后不再接收事件
3. 事件异步触发，可能有延迟

---

## AI 操作

### 添加 AI 模型

可以通过 `o-page` 组件引入密钥管理页面：

```html
<o-page src="https://core.noneos.com/nos-tool/ai/pages/key-manager.html"></o-page>
```

或使用相对路径：

```html
<o-page src="/nos-tool/ai/pages/key-manager.html"></o-page>
```

### 引入 chat 模块

```javascript
import { chat, subscribe, getStatus, getAvailableProviders } from "/nos/ai/chat.js";
```

### 基本用法

```javascript
const messages = [
  { role: "user", content: "你好" }
];

const response = await chat(messages, {
  provider: "deepseek",
  callback: (chunk) => {
    console.log(chunk);
  },
  maxContextLength: 8192
});
```

### 支持的提供商

- **deepseek** - DeepSeek
- **kimi** - Kimi (Moonshot)
- **minimax** - MiniMax
- **glm** - 智谱 GLM

### 消息格式

```javascript
const messages = [
  { role: "system", content: "你是一个有用的助手" },
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好，有什么可以帮助你的吗？" },
  { role: "user", content: "解释一下什么是 AI" }
];
```

### 并发控制

```javascript
const status = getStatus();

subscribe((newStatus) => {
  console.log("状态更新:", newStatus);
});
```

### 获取可用提供商

```javascript
const providers = await getAvailableProviders();
console.log(providers); // ["deepseek", "kimi", "glm", "minimax"]
```

### 错误处理

```javascript
try {
  const response = await chat(messages);
} catch (error) {
  console.error(error.message);
}
```

常见错误：
- `no_key` - 没有配置任何 API Key
- `no_provider_key` - 没有指定提供商的 API Key
- `concurrency_full` - 该 Key 的并发数已满
- `Unsupported provider` - 不支持的提供商

---

## 代码风格规范

1. **已有父句柄时**：使用 `parentDir.get("child.txt")`
2. **没有父句柄时**：使用全局 `await get("my-app/path/to/file.txt")`

```javascript
// 正确：用父句柄获取子项
const dir = await get("my-app/subDir");
await dir.get("file1.txt", { create: "file" });

// 正确：用全局 get 获取独立路径
const file = await get("my-app/other.txt", { create: "file" });
```

---

# 用户管理

LocalUser 是 NoneOS Core 的用户管理模块，提供基于 ECDSA 的密钥管理、数据签名验证和证书管理功能。

## 安装

确保已安装 NoneOS Core，参考 [NoneOS Core 安装文档](https://core.noneos.com)。

## 引入

```javascript
import { getUser } from "/nos/user/main.js";
```

## 基本用法

### 获取用户实例

```javascript
const user = await getUser("my-namespace");

console.log(user.userId);     // 用户唯一标识（公钥哈希）
console.log(user.publicKey);  // 用户公钥
console.log(user.namespace);  // "my-namespace"
```

`getUser` 会自动创建或获取已缓存的用户实例，并调用 `ready()` 准备用户。多次调用相同命名空间会返回同一个实例：

```javascript
const user1 = await getUser("app-user");
const user2 = await getUser("app-user");
console.log(user1 === user2); // true
```

### 数据签名与验证

```javascript
const user = await getUser("signer");

// 签名数据
const data = { message: "Hello, World!", timestamp: Date.now() };
const signedData = await user.sign(data);

// 验证签名
const isValid = await user.verify(signedData);
console.log(isValid); // true

// 篡改数据后验证失败
const tampered = { ...signedData, message: "Tampered!" };
console.log(await user.verify(tampered)); // false
```

## 个人信息管理

### 更新与获取

```javascript
const user = await getUser("my-user");

// 更新信息（自动签名并存储）
const info = await user.updateInfo({
  nickname: "我的昵称",
  email: "user@example.com"
});

// 获取已保存的信息
const userInfo = await user.getInfo();
console.log(userInfo.username);  // 默认用户名 "user-xxxxx"
console.log(userInfo.nickname);  // "我的昵称"
```

### 信息合并更新

多次调用 `updateInfo` 会合并数据，不会覆盖未更新的字段：

```javascript
await user.updateInfo({ nickname: "初始昵称", city: "北京" });
await user.updateInfo({ nickname: "新昵称", hobby: "编程" });

const info = await user.getInfo();
console.log(info.nickname); // "新昵称"
console.log(info.city);     // "北京"（保留）
console.log(info.hobby);    // "编程"（新增）
```

### 验证信息签名

```javascript
const info = await user.getInfo();
const isValid = await user.verify(info);
console.log(isValid); // true
```

## 证书管理

### 签发与导入

```javascript
const admin = await getUser("admin-user");
const normalUser = await getUser("normal-user");

// 管理员签发证书
const cert = await admin.cert.issue({
  subject: normalUser.userId,
  role: "editor",
  permissions: ["read", "write"]
});

// 用户导入证书（自动验证签名）
await normalUser.cert.import(cert);
```

### 查询与检查

```javascript
// 查询特定角色的证书
const editorCerts = await user.cert.query({ role: "editor" });

// 检查是否拥有某证书
const hasEditorRole = await user.cert.has({
  role: "editor",
  issuer: admin.userId
});
```

### 统计与遍历

```javascript
// 统计证书数量
const total = await user.cert.count();
const editorCount = await user.cert.count({ role: "editor" });

// 遍历所有证书（内存友好，使用游标）
for await (const cert of user.cert.values()) {
  console.log(`证书: ${cert.role} - ${cert.subject}`);
}

// 遍历特定条件的证书
for await (const cert of user.cert.values({ role: "editor" })) {
  console.log(`编辑权限: ${cert.subject}`);
}
```

### 删除证书

```javascript
await user.cert.delete(cert.id);
const hasCert = await user.cert.has({ role: "editor" });
console.log(hasCert); // false
```

## 远程用户与消息收发

本地用户可以通过 `connectUser(userId)` 连接到另一个在线用户，获得一个 `RemoteUser` 实例，用于发送消息、测量延迟等。

### 连接远程用户

```javascript
const user = await getUser("my-namespace");
// getUser() 已自动连接默认服务器，通常无需手动 connect
// 如需连接非默认服务器：await user.server.connect("ws://example.com:8081");

const remoteUser = await user.connectUser(targetUserId);
console.log(remoteUser.userId); // 目标用户的 userId
```

`connectUser` 会查询所有已连接的服务器，确认目标用户在线后返回 `RemoteUser`。同一 userId 多次调用会复用缓存实例。

### 获取对方 Session 列表

```javascript
const sessionIds = await remoteUser.getSessionIds();
```

### 发送消息

```javascript
// 发送普通对象（若双方已交换名片，会自动启用 E2EE 加密）
await remoteUser.send(sessionIds[0], { text: "hello", num: 42 });

// 发送二进制数据
const binary = new Uint8Array([0x01, 0x02, 0x03]);
await remoteUser.send(sessionIds[0], binary);

// 发送纯文本
await remoteUser.send(sessionIds[0], "hello");
```

**返回值：** `{ status: "ok", via: "rtc"|"server", url?: string, result?: object }`

- 默认对纯对象启用 E2EE 加密（需双方先通过 `user.card.get()` 交换名片）
- 第一次发送走服务器中转；第二次开始后台静默尝试 WebRTC 直连
- 若 WebRTC DataChannel 已就绪，优先走 RTC
- `raw=true` 为内部参数，跳过 E2EE（如名片协议自身）

### 接收消息

监听 `RemoteUser` 的 `message` 事件：

```javascript
remoteUser.bind("message", (event) => {
  const { fromUserId, fromSessionId, data, viaServer } = event.detail;
  console.log("收到来自", fromUserId, "的消息:", data);
});
```

也可直接监听 `LocalUser` 的 `message` 事件获取所有 relay 消息。

### 延迟测量

```javascript
const rtt = await remoteUser.ping(sessionIds[0]);
console.log("RTT:", rtt, "ms");

// 获取最近一次测量结果
console.log(remoteUser.getRTT(sessionIds[0]));
// { rtt: 23, via: "server", url: "ws://localhost:8081" }

// 不传 sessionId 返回所有 session 中最佳 RTT
console.log(remoteUser.getRTT());
```

`rtt_update` 事件会在每次 ping 成功后触发：

```javascript
user.bind("rtt_update", (event) => {
  console.log(event.detail); // { userId, sessionId, rtt, via, url }
});
```

---

## 用户导出/导入/删除

用户模块提供完整生命周期管理函数。

### 导出用户

```javascript
import { exportUser } from "/nos/user/main.js";

const encrypted = await exportUser("my-namespace", "password");
// 返回 base64 加密的字符串，包含密钥对和用户信息
```

### 导入用户

```javascript
import { importUser } from "/nos/user/main.js";

const user = await importUser("new-namespace", encrypted, "password");
// 若目标 namespace 已存在会抛出错误
```

### 删除用户

```javascript
import { deleteUser } from "/nos/user/main.js";

// 默认弹出两次确认对话框
await deleteUser("my-namespace");

// 跳过确认（适合脚本/测试）
await deleteUser("my-namespace", { skipConfirm: true });
```

删除会永久清除该 namespace 对应的 IndexedDB 数据库、内存缓存和所有本地数据。

---

## LocalUser 事件总览

`LocalUser` 继承自 `EventTarget`，可通过 `bind(eventName, callback)` 监听以下事件：

| 事件名 | 触发时机 | `event.detail` |
|--------|---------|----------------|
| `handshake` | 服务器握手完成或失败 | `{ url, status: "success"|"error", isAdmin?, version?, message? }` |
| `message` | 收到服务器或 RTC 转发消息 | `{ url, data, originalEvent }` |
| `close` | 服务器连接断开 | `{ url }` |
| `ws_error` | WebSocket 连接错误 | `{ url, error }` |
| `latency_test` | 单次延迟测试完成 | `{ url, rtt, oneWayLatency, clientTime, serverRecvTime, serverSendTime, clientRecvTime }` |
| `latency_monitor` | 延迟监测启动 | `{ status: "started", intervalMs }` |
| `rtt_update` | 用户间 ping 完成 | `{ userId, sessionId, rtt, via, url }` |
| `rtc_state` | WebRTC 连接状态变化 | `{ userId, sessionId, state: "connected"|"disconnected" }` |
| `card_received` | 收到并验证远程用户名片 | `{ userId, card, saved }` |

示例：

```javascript
const user = await getUser("my-namespace");

user.bind("handshake", (e) => {
  console.log("握手:", e.detail.url, e.detail.status, e.detail.version);
});

user.bind("message", (e) => {
  console.log("收到消息:", e.detail.url, e.detail.data);
});
```

---

## 服务器连接与延迟监测

每个 `LocalUser` 实例内置 `ServerManager`，通过 `user.server` 访问。`ready()` 完成后会自动尝试连接默认服务器列表。

### 连接服务器

```javascript
const user = await getUser("my-namespace");

// 连接指定服务器
const result = await user.server.connect("ws://localhost:8081");
console.log(result.success, result.version);

// 连接列表中所有服务器
await user.server.connectAll();
```

连接成功后服务器地址会被持久化。默认服务器列表为 `["ws://localhost:8081", "ws://localhost:8082"]`。

> **通常不需要手动连接**：`getUser()` 内部会调用 `ready()`，`ready()` 会自动执行 `connectAll()`，因此多数场景下直接 `await getUser("namespace")` 即可。只有需要连接非默认服务器时，才显式调用 `connect(url)`。

### 服务器列表管理

```javascript
const servers = await user.server.getServers();
await user.server.addServer("ws://example.com:8081");
await user.server.removeServer("ws://example.com:8081");
```

### 延迟测试与监测

```javascript
// 单次测试
const latency = await user.server.testLatency("ws://localhost:8081");
console.log(latency.rtt, latency.oneWayLatency);

// 启动周期性监测（默认 30 秒）
user.server.startLatencyMonitor();

// 停止
user.server.stopLatencyMonitor();
```

`testLatency` 返回：

```javascript
{
  rtt,              // 往返延迟（ms）
  oneWayLatency,    // 单向延迟估算（ms）
  clientTime,       // 客户端发送时间
  serverRecvTime,   // 服务器接收时间
  serverSendTime,   // 服务器发送时间
  clientRecvTime    // 客户端接收时间
}
```

连接成功后会自动启动静默延迟监测；所有连接断开后自动停止。

### 断开连接

```javascript
user.server.disconnect("ws://localhost:8081");
user.server.disconnectAll();
```

## 完整示例

```javascript
import { getUser } from "/nos/user/main.js";

// 创建管理员和普通用户
const admin = await getUser("admin-space");
const user = await getUser("user-space");

// 更新用户个人信息
await user.updateInfo({
  nickname: "普通用户",
  email: "user@example.com"
});

const userInfo = await user.getInfo();
console.log("用户昵称:", userInfo.nickname);
console.log("默认用户名:", userInfo.username);

// 管理员签发证书
const cert = await admin.cert.issue({
  subject: user.userId,
  role: "editor",
  permissions: ["read", "write"]
});

// 用户导入并验证证书
await user.cert.import(cert);

// 检查权限
const hasEditorRole = await user.cert.has({
  role: "editor",
  issuer: admin.userId
});
console.log("拥有编辑权限:", hasEditorRole);

// 统计证书
const totalCount = await user.cert.count();
console.log(`总共有 ${totalCount} 个证书`);

// 遍历证书
for await (const c of user.cert.values()) {
  console.log(`证书: ${c.role} - ${c.subject}`);
}

// 签名和验证文档
const document = { title: "Important Doc", content: "..." };
const signedDoc = await admin.sign(document);
console.log("文档签名有效:", await admin.verify(signedDoc));
```

## API 文档

### getUser(namespace)

获取用户实例的推荐方式。

**参数：**
- `namespace` (string) - 用户命名空间

**返回值：** Promise\<LocalUser\> - 已准备好的用户实例

**特性：**
- 自动缓存用户实例
- 自动调用 `ready()` 准备用户
- 相同命名空间返回同一实例

---

## LocalUser 类

如果需要直接使用 LocalUser 类（例如需要控制初始化时机），可以从 `/nos/user/local/user.js` 引入：

```javascript
import { LocalUser } from "/nos/user/local/user.js";
```

### 构造函数

#### `new LocalUser(namespace)`

创建本地用户实例。

**参数：**
- `namespace` (string) - 用户命名空间，用于区分不同的用户存储空间

**示例：**
```javascript
const user = new LocalUser("my-app-user");
await user.ready();
```

---

### LocalUser 属性

| 属性 | 类型 | 说明 |
|------|------|------|
| `namespace` | string | 用户命名空间 |
| `userId` | string | 用户唯一标识（公钥哈希） |
| `publicKey` | string | 用户公钥 |
| `sign` | Function \| null | 签名函数（只读模式返回 null） |
| `cert` | CertManager | 证书管理器实例 |

---

### LocalUser 方法

#### `ready()`

准备用户实例，从数据库加载密钥对，如果不存在则生成新的密钥对并保存。

**返回值：** Promise\<LocalUser\>

#### `sign(data)`

对数据进行签名，自动添加 `signTime` 和 `publicKey` 字段。

**参数：**
- `data` (Object) - 需要签名的数据对象

**返回值：** Promise\<Object\> - 包含原始数据、签名时间戳、公钥和签名的对象

#### `verify(signedData)`

验证数据签名是否正确。

**参数：**
- `signedData` (Object) - 包含 `signature` 字段的已签名数据对象

**返回值：** Promise\<boolean\> - 验证是否通过

#### `updateInfo(data)`

更新用户个人信息。数据会自动签名并存储到数据库，多次调用会合并数据。

**参数：**
- `data` (Object) - 需要更新的用户信息字段

**返回值：** Promise\<Object\> - 更新后的签名用户信息

**特性：**
- 自动添加 `userId` 字段
- 自动签名数据
- 合并现有信息，不会覆盖未更新的字段

#### `getInfo()`

获取已保存的用户信息。

**返回值：** Promise\<Object \| null\> - 已签名的用户信息，如果不存在则返回 null

---

## CertManager 类

证书管理器类，通过 `user.cert` 访问。

### CertManager 方法

#### `issue(options)`

签发证书。

**参数：**
- `options` (Object)
  - `subject` (string) - 被签发人的用户ID（必填）
  - `role` (string) - 角色（必填）
  - `...data` (Object) - 其他附加数据（可选）

**返回值：** Promise\<Object\> - 签发后的证书对象

#### `import(certData)`

验证并导入证书。会自动验证：
- 证书签名是否有效
- `issuer` 是否与公钥匹配

**参数：**
- `certData` (Object) - 包含签名和公钥的证书数据

**返回值：** Promise\<Object\> - 导入后的证书

**抛出错误：**
- 缺少必要字段
- 用户ID与公钥不匹配
- 证书签名验证失败

#### `query(query)`

查询证书。

**参数：**
- `query` (Object) - 查询条件
  - `role` (string) - 角色（可选）
  - `issuer` (string) - 签发者ID（可选）
  - `subject` (string) - 接收者ID（可选）

**返回值：** Promise\<Array\<Object\>\> - 证书数组

#### `has(query)`

检查是否拥有某证书。

**参数：**
- `query` (Object) - 查询条件（同 `query`）

**返回值：** Promise\<boolean\>

#### `delete(id)`

删除证书。

**参数：**
- `id` (string) - 证书ID

**返回值：** Promise\<void\>

#### `count(query)`

获取证书数量。

**参数：**
- `query` (Object) - 查询条件（可选）

**返回值：** Promise\<number\>

#### `values(query)`

获取证书异步迭代器，支持 `for await...of` 语法遍历。使用 IndexedDB 游标实现，内存友好。

**参数：**
- `query` (Object) - 查询条件（可选）

**返回值：** AsyncIterable

## 安全特性

### 密钥管理

- 使用 ECDSA 算法生成密钥对
- 私钥安全存储在 IndexedDB 中
- 用户ID由公钥哈希生成，确保唯一性
- 密钥持久化，重新初始化时自动加载

### 证书验证

保存证书时会自动验证：
1. 必要字段完整性（role、issuer、subject、publicKey、signTime、signature）
2. 签发者ID与公钥匹配
3. 签名有效性

### 防篡改机制

```javascript
// 篡改证书会被检测
const fakeCert = { ...originalCert, issuer: "hacker-id" };
await user.cert.import(fakeCert); // 抛出错误: "用户ID与公钥不匹配"
```
