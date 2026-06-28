# DataPublisher - 数据发布管理器

DataPublisher 是 NoneOS Core 的数据发布模块，基于 `LocalUser` 实现文件的分块发布、清单与块数据的请求响应，支持点对点（通过服务器中转或 WebRTC）传输任意大小的文件。

## 特性

- **分块存储**：按 255KB 切分文件，每块独立 SHA-256 哈希，避免一次性读入大文件爆内存
- **签名清单**：文件清单（manifest）由发布者私钥签名，接收方验签后才存储，防止篡改
- **去中心化分发**：任何持有文件的用户都可以响应他人的请求，无需中心服务器存储文件内容
- **自动复用**：本地已存在的 chunk/manifest 直接返回，避免重复请求
- **并发去重**：同一 chunkHash/fileHash 的并发请求自动合并为同一个 Promise
- **二进制高效传输**：chunk 数据走二进制 relay 通道，无 base64 开销

## 引入

```javascript
import { DataPublisher } from "/nos/publish/data-publisher.js";
```

## 基本用法

### 初始化

```javascript
import { getUser } from "/nos/user/main.js";
import { DataPublisher } from "/nos/publish/data-publisher.js";

const user = await getUser("my-namespace");
const publisher = new DataPublisher(user);
publisher.start(); // 启动监听，响应 incoming 请求
```

### 发布文件

```javascript
const file = new File([/* ... */], "photo.jpg", { type: "image/jpeg" });
const manifest = await publisher.publish(file);

console.log(manifest.fileHash);     // 文件唯一哈希
console.log(manifest.chunkHashes);  // 各分块哈希列表
console.log(manifest.fileName);     // "photo.jpg"
console.log(manifest.fileSize);     // 文件字节数
console.log(manifest.signature);   // 发布者签名
```

`publish` 内部流程：
1. 按 255KB 分块，使用 `file.slice()` 流式读取（避免爆内存）
2. 每块计算 SHA-256 得到 `chunkHash`，立即存入 `file_chunks` 表
3. 所有 `chunkHash` 按顺序拼接成字符串，再计算 SHA-256 得到 `fileHash`
4. 构建 `{ fileHash, chunkHashes, fileName, fileSize }` 并用 `user._sign()` 签名
5. 将 manifest 存入 `file_manifests` 表

### 请求他人的文件

```javascript
// 连接远程用户
const remoteUser = await user.connectUser(targetUserId);
const sessionIds = await remoteUser.getSessionIds();

// 1. 请求文件清单
const manifest = await publisher.requestManifest(
  remoteUser,
  targetFileHash,
  sessionIds[0]
);

// 2. 请求所有分块
for (const chunkHash of manifest.chunkHashes) {
  const chunkData = await publisher.requestChunk(
    remoteUser,
    chunkHash,
    sessionIds[0]
  );
}

// 3. 组装完整文件
const result = await publisher.assembleFile(targetFileHash);
// result.blob       -> Blob 对象
// result.fileName   -> 原文件名
// result.fileSize   -> 原文件大小
```

### 下载并保存到本地

```javascript
const result = await publisher.assembleFile(fileHash);
const url = URL.createObjectURL(result.blob);
const a = document.createElement("a");
a.href = url;
a.download = result.fileName;
a.click();
URL.revokeObjectURL(url);
```

---

## API 文档

### `DataPublisher` 类

#### `new DataPublisher(localUser)`

**参数：**
- `localUser` (LocalUser) - 本地用户实例，用于签名、收发消息

#### `start()`

启动监听，绑定 `localUser` 的 `message` 事件，开始响应 incoming 的 manifest/chunk 请求。重复调用安全（幂等）。

#### `stop()`

停止监听，并清理所有进行中的请求 Promise（reject 掉所有未完成的 `requestManifest` / `requestChunk`）。

#### `publish(file)`

发布本地文件。

**参数：**
- `file` (File | Blob) - 要发布的文件

**返回值：** Promise\<Object\> - manifest 对象

**manifest 结构：**
```json
{
  "fileHash": "abc...",
  "chunkHashes": ["hash0", "hash1", "..."],
  "fileName": "example.jpg",
  "fileSize": 1048576,
  "signTime": 1234567890,
  "publicKey": "MIIBIjANBgkqhkiG9w0BAQ...",
  "signature": "MEQCIF6wJm... (base64)"
}
```

#### `requestManifest(remoteUser, fileHash, sessionId)`

请求远程用户的文件清单。先查本地 DB，命中则直接返回；否则发起网络请求。

**参数：**
- `remoteUser` (RemoteUser) - 远程用户实例
- `fileHash` (string) - 文件哈希
- `sessionId` (string, optional) - 目标会话 ID，不传则自动获取第一个可用会话

**返回值：** Promise\<Object\> - manifest 对象

**超时：** 10 秒

#### `requestChunk(remoteUser, chunkHash, sessionId)`

请求远程用户的块数据。先查本地 DB，命中则直接返回；否则发起网络请求。

**参数：**
- `remoteUser` (RemoteUser) - 远程用户实例
- `chunkHash` (string) - 块哈希
- `sessionId` (string, optional) - 目标会话 ID，不传则自动获取第一个可用会话

**返回值：** Promise\<ArrayBuffer\> - 块二进制数据

**超时：** 15 秒

**说明：** 收到二进制数据后会重新计算 SHA-256 与请求的 `chunkHash` 比对，匹配才会存入 DB 并 resolve。

#### `assembleFile(fileHash)`

从本地 DB 读取 manifest 和所有 chunk，按顺序拼装为 Blob。

**参数：**
- `fileHash` (string) - 文件哈希

**返回值：** Promise\<{ blob: Blob, fileName: string, fileSize: number }\>

**抛出错误：**
- manifest 不存在：`Manifest not found: <fileHash>`
- chunk 缺失：错误对象带 `missing` 字段（缺失的 chunkHash 数组）和 `fileHash` 字段

#### `fetchFile(remoteUser, fileHash, sessionId)`

获取完整文件。优先从本地 DB 读取，若缺失则自动从远程用户拉取 manifest 和所有 chunk。

**参数：**
- `remoteUser` (RemoteUser) - 远程用户实例
- `fileHash` (string) - 文件哈希
- `sessionId` (string, optional) - 目标会话 ID，不传则自动获取第一个可用会话

**返回值：** Promise\<{ blob: Blob, fileName: string, fileSize: number }\>

---

## 协议规范

### 消息类型

所有协议消息的 `type` 字段为 `"data_publish"`，通过 `action` 区分具体操作。

### 请求方 → 应答方

通过 `remoteUser.send(sessionId, msg, true)` 发送（第三个参数 `true` 表示 raw 模式跳过 E2EE，因为协议内容本身公开）。

**请求 manifest：**
```json
{
  "type": "data_publish",
  "action": "request_manifest",
  "fileHash": "abc..."
}
```

**请求 chunk：**
```json
{
  "type": "data_publish",
  "action": "request_chunk",
  "chunkHash": "def..."
}
```

### 应答方 → 请求方

通过 `server.relayToUserViaServer(url, fromUserId, fromSessionId, data)` 回复。

**回复 manifest（存在）：** 直接发送 manifest 对象（不带 `type`/`action`，接收方通过结构特征识别）

**回复 manifest（不存在）：**
```json
{
  "type": "data_publish",
  "action": "manifest_response",
  "fileHash": "abc...",
  "error": "not_found"
}
```

**回复 chunk（存在）：** 发送 chunk 原始二进制数据（ArrayBuffer），走二进制 relay 通道

**回复 chunk（不存在）：**
```json
{
  "type": "data_publish",
  "action": "chunk_response",
  "chunkHash": "def...",
  "error": "not_found"
}
```

### 二进制 chunk 识别

二进制 relay 帧的 header 不携带 `chunkHash` 字段。接收方收到二进制数据后**重新计算 SHA-256**，与当前正在请求的 `chunkHash` 比对，匹配即为该请求的响应。

---

## 数据库设计

DataPublisher 使用独立的 IndexedDB 数据库 `nos_publish_data`（版本 1），不依赖 `nos/user/db.js`。

### 对象仓库

#### `file_chunks`

| key | value |
|-----|-------|
| chunkHash (string) | 块原始二进制数据 (ArrayBuffer) |

存自己和别人的块数据。

#### `file_manifests`

| key | value |
|-----|-------|
| fileHash (string) | manifest 对象（含签名） |

存自己和别人的文件清单。别人的 manifest 需验签通过才会存入。

### 工具函数

可通过 `/nos/publish/db.js` 直接访问底层 DB：

```javascript
import {
  saveChunk,
  getChunk,
  saveManifest,
  getManifest,
  deleteChunk,
  deleteManifest
} from "/nos/publish/db.js";
```

| 函数 | 说明 |
|------|------|
| `saveChunk(chunkHash, data)` | 存入一个块 |
| `getChunk(chunkHash)` | 读取一个块，返回 ArrayBuffer \| null |
| `saveManifest(fileHash, manifest)` | 存入一个 manifest |
| `getManifest(fileHash)` | 读取一个 manifest，返回 Object \| null |
| `deleteChunk(chunkHash)` | 删除一个块 |
| `deleteManifest(fileHash)` | 删除一个 manifest |

---

## 分块与哈希算法

```
File
 ├── 按 255KB (255 * 1024 字节) 切分
 ├── chunk[0], chunk[1], ..., chunk[n-1]
 ├── 每个 chunk[i] → SHA-256 → chunkHash[i] (hex string)
 ├── 将所有 chunkHash 按顺序拼接成一个字符串 → SHA-256 → fileHash (hex string)
 └── 发布对象 = { fileHash, chunkHashes, fileName, fileSize } 再 _sign
```

### 签名验证

收到他人的 manifest 后：
1. 用 `verifyData(manifest)` 验证签名（内部会去掉 `signature` 字段，用 `publicKey` 验证剩余字段）
2. 验证通过才存入 `file_manifests` 表
3. 验证不通过直接丢弃

`_sign` 会对字段排序后序列化，`verifyData` 使用相同的序列化规则，保证签名一致性。

---

## 完整示例

### 发布方

```javascript
import { getUser } from "/nos/user/main.js";
import { DataPublisher } from "/nos/publish/data-publisher.js";

const user = await getUser("publisher");
const publisher = new DataPublisher(user);
publisher.start();

// 用户选择文件后发布
const fileInput = document.querySelector("input[type=file]");
const file = fileInput.files[0];
const manifest = await publisher.publish(file);

console.log("已发布:", manifest.fileHash);
// 将 fileHash 分享给其他人
```

### 请求方

```javascript
import { getUser } from "/nos/user/main.js";
import { DataPublisher } from "/nos/publish/data-publisher.js";

const user = await getUser("downloader");
const publisher = new DataPublisher(user);
publisher.start();

// 从某处获得 fileHash 和发布者 userId
const fileHash = "abc...";
const publisherUserId = "user-xxxxx";

const remoteUser = await user.connectUser(publisherUserId);
const sessionIds = await remoteUser.getSessionIds();

// 请求 manifest
const manifest = await publisher.requestManifest(
  remoteUser,
  fileHash,
  sessionIds[0]
);

// 请求所有 chunk
for (const chunkHash of manifest.chunkHashes) {
  await publisher.requestChunk(remoteUser, chunkHash, sessionIds[0]);
}

// 组装并下载
const result = await publisher.assembleFile(fileHash);
const url = URL.createObjectURL(result.blob);
const a = document.createElement("a");
a.href = url;
a.download = result.fileName;
a.click();
URL.revokeObjectURL(url);
```

---

## 实现说明

### 大文件流式处理

`publish` 使用 `file.slice(start, end)` 分批读取，每读一块 → 算 hash → 存 DB，再读下一块。不会一次性 `await file.arrayBuffer()` 整个文件，避免大文件爆内存。

### E2EE 与 raw 模式

`data_publish` 协议消息是公开数据（文件哈希、清单等），不需要 E2EE 加密。通过 `remoteUser.send(sessionId, data, true)` 的第三个参数 `raw=true` 绕过加密。

二进制 chunk 数据本身是文件内容（可能已加密或为公开数据），由应用层决定是否额外加密，DataPublisher 不介入。

### 并发请求处理

`requestManifest` 和 `requestChunk` 内部使用 Promise Map（`#manifestRequestMap` / `#chunkRequestMap`）做请求-响应匹配，同一 hash 的并发请求自动合并为同一个 Promise，避免重复发送。

### 消息路由

`start()` 中监听 `user.bind("message", handler)`，收到消息后：
1. 仅处理文本 relay（JSON），二进制帧由 `user.js` 解析后分发到 `RemoteUser`
2. 解析 relay 格式，获取 `parsed.data`
3. 判断是否为 manifest 响应（通过结构特征：有 `fileHash`/`chunkHashes`/`signature`/`publicKey` 且无 `type`）
4. 否则判断 `parsed.data.type === "data_publish"` 走协议处理逻辑

### 二进制 chunk 接收

`requestChunk` 内部监听 `RemoteUser` 的 `message` 事件：
- 收到二进制数据 → 转为 Uint8Array → 重新计算 SHA-256 → 与请求的 `chunkHash` 比对 → 匹配则存入 DB 并 resolve
- 收到 JSON 错误响应（`action: "chunk_response"` 且 `chunkHash` 匹配）→ reject

---

## 测试

查看测试文件了解更多用法：

- [DataPublisher 测试](../../tests/publish/data-publisher.sb.html)

测试覆盖：
- 本地文件发布（小文件 / 大文件多块）
- 文件组装（小文件 / 大文件 / 缺失 chunk 报错）
- 远程请求 manifest / chunk
- 请求不存在的 manifest / chunk 报错
- `fetchFile` 获取文件（本地 / 远程 / 不传 sessionId）
- `requestManifest` / `requestChunk` 不传 sessionId（自动获取）
- sessionId 缓存命中
- 非当前 session 关闭不影响请求
- 完整远程发布与组装流程

---

# AppManager - 应用发布管理器

AppManager 基于 DataPublisher 构建，提供应用的发布、发现、安装与版本管理功能。

## 特性

- **签名保障**：每个应用的 asset-manifest.json 由发布者私钥签名，安装时验签，防止篡改
- **分步发布**：`createRelease` 预览确认 → `publish` 真正发布，防误操作
- **版本链**：manifest 通过 `previousManifestHash` 形成哈希链，追溯版本历史
- **增量升级**：升级场景跳过 hash 未变的文件，只拉取有变化的部分
- **文件引用计数**：自动追踪文件引用，unpublish 时无引用则清理
- **推荐机制**：可将已安装的应用推荐给他人，扩展应用发现网络
- **幂等操作**：卸载/下架/取消推荐不存在的内容均静默成功

## 引入

```javascript
import { AppManager } from "/nos/publish/app-manager.js";
```

## 基本用法

### 初始化

```javascript
import { getUser } from "/nos/user/main.js";
import { AppManager } from "/nos/publish/app-manager.js";

const user = await getUser("my-namespace");
const manager = new AppManager(user);
manager.start(); // 启动内部 DataPublisher 监听
```

### 发布应用

```javascript
import { init } from "/nos/fs/handle/main.js";

// 准备应用目录
const handle = await init("my-app");
const html = await handle.get("index.html", { create: "file" });
await html.write("<h1>Hello World</h1>");
const js = await handle.get("app.js", { create: "file" });
await js.write("console.log('hello');");

// 第一步：创建发布候选（预览阶段，不发布文件）
const release = await manager.createRelease(handle, {
  appName: "my-app",
  version: "0.1.0",
});

console.log(release.fileCount);    // 文件数量
console.log(release.totalSize);    // 总大小
console.log(release.diffSummary);  // 升级场景的变更摘要
console.log(release.manifest);     // 已签名的 asset-manifest.json

// 第二步：确认后正式发布
const result = await manager.publish(release);
// result: { appId, appName, version, publishedAt }
```

发布后，应用的 asset-manifest.json 和其他所有文件都会通过内部的 DataPublisher 发布，其他用户可以通过 `fetchManifest` 和 `installApp` 来获取和安装。

### 发现应用

```javascript
// 获取自身发布的应用列表
const myApps = await manager.listMyPublishedApps();

// 获取已安装的应用列表
const installed = await manager.listInstalledApps();

// 发现已发布的应用（按发布者筛选）
const published = await manager.discoverApps({
  publisherUserId: "target-user-id",
});
```

### 安装应用

```javascript
// 获取应用的 asset-manifest.json
const manifest = await manager.fetchManifest(appId);

if (manifest) {
  // 安装（写入 apps/{appName}-{appId}/ 目录）
  await manager.installApp(manifest);

  // 安装后可通过 /$apps/{appName}-{appId}/ 访问
}
```

安装后的目录结构：
```
apps/
  my-app-<appId>/
    index.html
    app.js
    asset-manifest.json
```

### 检查更新

```javascript
// 检查单个应用
const update = await manager.checkForUpdates(appId);
if (update && update.hasUpdate) {
  console.log(`从 ${update.currentVersion} 升级到 ${update.latestVersion}`);
  console.log(update.diffSummary);  // { added, modified, removed, sizeDelta }

  // 用户确认后安装
  await manager.installApp(update.manifest);
}

// 批量检查所有已安装应用
const allUpdates = await manager.checkAllUpdates();
```

### 卸载与下架

```javascript
// 卸载本地已安装的应用
await manager.uninstallApp("my-app");

// 下架自己发布的应用（不下架文件数据，可重新上架）
await manager.unpublishApp("my-app");
// 要重新上架，用 publish() 即可
```

### 推荐应用

```javascript
// 推荐一个已安装的别人发布的应用
await manager.recommendApp(appId, publisherUserId);

// 取消推荐
await manager.unrecommendApp(appId, publisherUserId);
```

---

## API 文档

### `AppManager` 类

#### `new AppManager(localUser)`

**参数：**
- `localUser` (LocalUser) - 本地用户实例

#### `start()`

启动内部 DataPublisher 监听，开始响应 incoming 请求。

#### `stop()`

停止监听并清理进行中的请求。

#### `createRelease(handle, { appName, version })`

创建发布候选（预览阶段）。

**参数：**
- `handle` (DirHandle) - 应用的虚拟目录 Handle
- `appName` (string) - 应用名称
- `version` (string) - 语义化版本号 (如 "0.1.0")

**返回值：** Promise\<ReleaseInfo\>

**ReleaseInfo 结构：**
```json
{
  "manifest": { /* 已签名的 asset-manifest.json */ },
  "diffSummary": { /* 升级场景的变更摘要，首次发布为 null */ },
  "fileCount": 3,
  "totalSize": 10240
}
```

**diffSummary 结构：**
```json
{
  "added": { "new.js": { "fileHash": "abc...", "size": 512 } },
  "modified": { "index.html": { "oldHash": "...", "newHash": "...", "oldSize": 10, "newSize": 20 } },
  "removed": { "old.txt": { "fileHash": "abc...", "size": 100 } },
  "sizeDelta": 412
}
```

#### `publish(release)`

正式发布应用。验签 → 逐个 publish 文件（验证 hash） → publish manifest → 记录 DB。

**参数：**
- `release` (ReleaseInfo) - `createRelease` 返回的对象

**返回值：** Promise\<{ appId, appName, version, publishedAt }\>

**注意：** 篡改 `release.manifest` 会导致验签失败抛出错误。

#### `discoverApps({ publisherUserId? })`

发现应用列表。

**参数：**
- `publisherUserId` (string, optional) - 按发布者筛选

**返回值：** Promise\<AppInfo[]\>

**AppInfo 结构：** `{ appId, appName, version, publisherUserId, publishedAt }`

#### `fetchManifest(appId)`

获取已发布应用的 asset-manifest.json。

**参数：**
- `appId` (string) - 应用 ID

**返回值：** Promise\<Object|null\> - 签名的 manifest 对象，未找到返回 null

#### `installApp(manifest, { publisherUser? })`

安装应用。

**参数：**
- `manifest` (Object) - 签名的 asset-manifest.json 对象
- `publisherUser` (RemoteUser, optional) - 发布者的 RemoteUser，不传则只从本地 DataPublisher 缓存中读取

**返回值：** Promise\<void\>

写入路径：`apps/{appName}-{appId}/`

**升级场景：** 如果目录已存在，只拉取 hash 变化的文件，删除旧版有但新版没有的文件。

#### `checkForUpdates(appId)`

检查单个应用是否有更新。

**参数：**
- `appId` (string) - 应用 ID

**返回值：** Promise\<UpdateInfo|null\>

**UpdateInfo 结构：**
```json
{
  "hasUpdate": true,
  "appName": "my-app",
  "currentVersion": "0.1.0",
  "latestVersion": "0.2.0",
  "diffSummary": { "added": {}, "modified": {}, "removed": {}, "sizeDelta": 0 },
  "manifest": { /* 最新的 signed manifest */ }
}
```

- `null` — 未找到已安装的应用
- `{ hasUpdate: false }` — 已是最新

#### `checkAllUpdates()`

批量检查所有已安装应用的更新。

**返回值：** Promise\<UpdateInfo[]\>

#### `listInstalledApps()`

获取所有已安装应用的列表。

**返回值：** Promise\<AppInfo[]\>

#### `getInstalledAppInfo(appName)`

根据 appName 获取已安装应用的 asset-manifest.json。

**参数：**
- `appName` (string) - 应用名称

**返回值：** Promise\<Object|null\>

#### `uninstallApp(appName)`

卸载已安装的应用。幂等，不存在则静默成功。

**参数：**
- `appName` (string) - 应用名称

**返回值：** Promise\<void\>

#### `listMyPublishedApps()`

获取自己发布的应用列表。

**返回值：** Promise\<AppInfo[]\>

#### `unpublishApp(appName)`

下架自己发布的应用（仅改状态，不删文件数据）。幂等。

**参数：**
- `appName` (string) - 应用名称

**返回值：** Promise\<void\>

#### `recommendApp(appId, publisherUserId)`

推荐一个应用。已存在则跳过。

**参数：**
- `appId` (string) - 应用 ID
- `publisherUserId` (string) - 发布者用户 ID

**返回值：** Promise\<void\>

#### `unrecommendApp(appId, publisherUserId)`

取消推荐。幂等。

**参数：**
- `appId` (string) - 应用 ID
- `publisherUserId` (string) - 发布者用户 ID

**返回值：** Promise\<void\>

---

## 数据库设计

AppManager 在 DataPublisher 的 IndexedDB 中新增以下对象仓库（版本 2）：

### `published_apps`

| 字段 | 类型 | 说明 |
|------|------|------|
| `appName` | string | 应用名称（keyPath） |
| `appId` | string | 应用唯一标识 |
| `version` | string | 当前版本号 |
| `manifestHash` | string | 最新 manifest 的 fileHash |
| `publisherUserId` | string | 发布者用户 ID |
| `status` | string | `"published"` / `"unpublished"` |
| `publishedAt` | number | 首次发布时间 |
| `updatedAt` | number | 最后更新时间 |

### `file_refs`

| 字段 | 类型 | 说明 |
|------|------|------|
| `fileHash` | string | 文件哈希（keyPath） |
| `refCount` | number | 引用计数 |
| `appIds` | string[] | 引用该文件的应用 ID 列表 |

### `recommendations`

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一标识（keyPath），格式为 `{appId}-{publisherUserId}` |
| `appId` | string | 应用 ID |
| `appName` | string | 应用名称 |
| `publisherUserId` | string | 发布者用户 ID |
| `recommendedAt` | number | 推荐时间 |

---

## 数据流

### 发布流程

```
createRelease(handle, { appName, version })
  │
  ├── handle.flat() → 获取所有文件
  ├── 每个文件 → getFileHash() → { fileHash, size }
  ├── 计算 appId = sha256(appName + userId)
  ├── 读取旧 manifest（存在则计算 diffSummary）
  ├── _sign({ appId, appName, version, publisherUserId, previousManifestHash, files })
  └── 返回 ReleaseInfo（缓存文件 Blob）

publish(release)
  │
  ├── 验签 verifyData(manifest)
  ├── 对每个文件：DataPublisher.publish(blob) + incrementFileRef
  ├── 发布 manifest 自身 → 得到 manifestHash
  ├── 保存/更新 published_apps 记录
  └── 清理 release 缓存
```

### 安装流程

```
installApp(manifest)
  │
  ├── 验签 verifyData(manifest)
  ├── 创建 apps/{appName}-{appId}/ 目录
  ├── 读取旧 manifest（升级场景）
  ├── 遍历 files：
  │     ├── hash 相同且旧文件存在 → 跳过
  │     └── 否则 → DataPublisher.fetchFile() → 写入
  ├── 删除旧版有但新版没有的文件
  └── 写入 asset-manifest.json
```

### 文件引用计数

```
publish() 时：
  incrementFileRef(fileHash, appId)
    → refCount +1, appIds.push(appId)

decrementFileRef(fileHash, appId)  // unpublish 时
    → refCount -1
    → refCount === 0 → 清理该文件 manifest 和所有 chunks
```

---

## 完整示例

### 发布一个完整应用

```javascript
import { getUser } from "/nos/user/main.js";
import { AppManager } from "/nos/publish/app-manager.js";
import { init } from "/nos/fs/handle/main.js";

const user = await getUser("publisher");
const manager = new AppManager(user);
manager.start();

// 准备应用文件
const appDir = await init("my-web-app");
const html = await appDir.get("index.html", { create: "file" });
await html.write("<h1>My App</h1>");
const js = await appDir.get("src/app.js", { create: "file" });
await js.write("console.log('hello');");

// 预览
const release = await manager.createRelease(appDir, {
  appName: "my-web-app",
  version: "1.0.0",
});
console.log("文件数:", release.fileCount, "总大小:", release.totalSize);

// 确认并发布
const result = await manager.publish(release);
console.log("已发布:", result.appId);
```

### 安装他人应用

```javascript
import { getUser } from "/nos/user/main.js";
import { AppManager } from "/nos/publish/app-manager.js";

const user = await getUser("installer");
const manager = new AppManager(user);
manager.start();

// 从某处获得 appId 和发布者信息
const appId = "abc...";
const publisherUserId = "user-xxx";

// 获取 manifest
const manifest = await manager.fetchManifest(appId);
if (manifest) {
  await manager.installApp(manifest);
  console.log("安装完成");
}

// 检查是否有更新
const update = await manager.checkForUpdates(appId);
if (update?.hasUpdate) {
  if (confirm(`发现新版本 ${update.latestVersion}，是否升级？`)) {
    await manager.installApp(update.manifest);
  }
}
```

---

## 测试

查看测试文件了解更多用法：

- [AppManager 测试](../../tests/publish/app-publisher.sb.html)

测试覆盖：
- `createRelease` 基本功能
- `publish` 基本功能
- `publish` 防篡改验证
- `discoverApps` 列出已发布应用
- `fetchManifest` 获取应用清单
- `createRelease` 升级 diff 场景
- `installApp` 安装与内容验证
- `checkForUpdates` 检测升级
- `checkAllUpdates` 批量检查
- `listInstalledApps` / `getInstalledAppInfo` / `uninstallApp`
- `listMyPublishedApps` / `unpublishApp`
- `recommendApp` / `unrecommendApp`
