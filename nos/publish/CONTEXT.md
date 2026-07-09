# nos/publish 发布模块上下文

> 本文档供 AI 阅读，用于快速理解 `nos/publish` 模块的整体架构与实现细节，无需逐文件阅读源码即可进行代码更新。
> 本模块依赖 `nos/user`（身份/签名/中继）与 `nos/fs`（应用目录），是去中心化数据/应用分发层。

## 一、整体架构

`nos/publish` 提供基于内容寻址（content-addressed）的去中心化数据与应用分发能力。任何持有数据的用户都可响应他人请求，无需中心服务器存储文件内容。模块分两层：

1. **DataPublisher（数据层）**：将任意 `File/Blob` 按 128KB 分块，每块 SHA-256 哈希，构建经发布者私钥签名的 manifest，通过中继通道在用户间请求/响应 chunk 与 manifest。
2. **AppManager（应用层）**：基于 DataPublisher，提供应用的发布、发现、安装、增量升级、引用计数与推荐机制。应用的 `asset-manifest.json` 本身也作为一个文件被发布。

### 核心设计

1. **内容寻址**：`chunkHash = SHA-256(chunkData)`；`fileHash = SHA-256(chunkHashes.join(""))`。相同内容必然产生相同哈希，天然去重。
2. **签名清单**：manifest 由 `LocalUser._sign()` 签名；接收方 `verifyData()` 验签后才存入 DB，防篡改。
3. **raw 模式**：协议消息（`data_publish` 类型）内容公开，通过 `remoteUser.send(sid, msg, true)` 第三参数 `true` 跳过 E2EE。
4. **二进制高效传输**：chunk 数据走二进制 relay 通道（`server.relayToUserViaServer` 自动识别二进制并走二进制帧），无 base64 开销。
5. **本地优先 + 远程兜底**：所有请求先查本地 IndexedDB，未命中才发起网络请求。
6. **并发去重**：同一 `fileHash`/`chunkHash` 的并发请求自动合并为同一个 Promise。
7. **sessionId 缓存与重试**：首次 `getSessionIds()` 后缓存；当前 session 断开自动失效缓存并重试一次。

## 二、模块地图

```
nos/publish/
├── data-publisher.js    # DataPublisher：文件分块发布/请求/组装
├── app-manager.js       # AppManager extends DataPublisher：应用发布/发现/安装/升级
├── db.js                # IndexedDB 持久化（5 个仓库，version 2）
├── README.md            # API 文档（人类阅读，部分数值已过时，以本文档为准）
└── CONTEXT.md           # 本文档
```

## 三、类关系

```
DataPublisher (data-publisher.js)       ← 依赖 LocalUser
  ├── 被 AppManager 内聚（非继承）
  │     AppManager (app-manager.js)     ← #publisher = new DataPublisher(user)
  └── 协议处理：start() 监听 user "message" 事件
```

- `AppManager` 持有一个 `#publisher: DataPublisher` 实例（组合而非继承），`start()` 转发调用 `#publisher.start()`。
- `#releaseCache: WeakMap` -- `createRelease` 返回的冻结对象 -> `{ fileBlobs }`，`publish` 时取出缓存，发布后删除，防止篡改与重复发布。

## 四、关键 API

### DataPublisher（data-publisher.js）

| 方法 | 说明 |
|------|------|
| `start()` | 绑定 `user.bind("message")` 监听 incoming 请求；幂等 |
| `stop()` | 解绑并 reject 所有进行中请求，清空缓存 |
| `publish(file)` | 流式分块（`file.slice` 128KB）-> 每块 SHA-256 存 DB -> 拼 chunkHashes 算 fileHash -> `_sign` manifest -> 存 DB -> 返回 manifest |
| `requestManifest(remoteUser, fileHash, sessionId?)` | DB 优先 -> 网络请求（10s 超时）；断开自动重试一次 |
| `requestChunk(remoteUser, chunkHash, sessionId?)` | DB 优先 -> 网络请求（15s 超时）；收到二进制重算 SHA-256 匹配；断开自动重试一次 |
| `assembleFile(fileHash)` | 从 DB 读 manifest + 所有 chunk -> Blob；缺失 chunk 抛错（带 `missing`/`fileHash` 字段） |
| `fetchFile(remoteUser, fileHash, sessionId?)` | 本地 `assembleFile` 优先 -> 远程拉 manifest -> 并发拉所有缺失 chunk -> 再次组装 |

### AppManager（app-manager.js）

| 方法 | 说明 |
|------|------|
| `start()` / `stop()` | 转发到内部 DataPublisher |
| `createRelease(handle, {appName, version})` | `handle.flat()` 遍历文件 -> 每文件 `getFileHash` -> 计算 `appId = sha256(appName + userId)` -> 读旧 manifest 算 diffSummary -> `_sign` asset-manifest -> 冻结为 ReleaseInfo 并缓存 fileBlobs（**不发布文件**） |
| `publish(release)` | `verifyData(manifest)` 验签 -> 逐文件 `getFileHash` 复核 -> `DataPublisher.publish(blob)` -> `incrementFileRef` -> 发布 manifest 自身 -> 保存 `published_apps` 记录 -> 清缓存 |
| `discoverApps({publisherUserId?})` | 查本地 `published_apps`（status=published） |
| `fetchManifest(appId)` | 查 `published_apps` 拿 `manifestHash` -> `DataPublisher.assembleFile` -> JSON.parse |
| `installApp(manifest, {publisherUser?})` | 验签 -> 建 `apps/{appName}-{appId}/` -> 读旧 manifest（升级场景）-> 仅拉 hash 变化的文件 -> 删除新版缺失文件 -> 写 `asset-manifest.json` |
| `checkForUpdates(appId)` | 比对本地已安装版本与发布者最新版本（`semverCompare`），生成 diffSummary |
| `checkAllUpdates()` | 遍历 `apps/` 目录所有已安装应用，逐一 `checkForUpdates` |
| `listInstalledApps()` / `getInstalledAppInfo(appName)` / `uninstallApp(appName)` | 遍历 `apps/` 目录的 `asset-manifest.json`；卸载整体删除目录（幂等） |
| `listMyPublishedApps()` / `unpublishApp(appName)` | 仅改 `status` 为 `unpublished`，不删文件数据（幂等） |
| `recommendApp(appId, publisherUserId)` / `unrecommendApp(...)` | 推荐记录（幂等） |

### db.js 工具函数

| 函数 | 说明 |
|------|------|
| `saveChunk` / `getChunk` / `deleteChunk` | chunk 存/读/删（key=chunkHash，value=ArrayBuffer） |
| `saveManifest` / `getManifest` / `deleteManifest` | manifest 存/读/删（key=fileHash） |
| `savePublishedApp` / `getPublishedApp` / `listPublishedApps` / `deletePublishedApp` | 应用发布记录（keyPath=appName） |
| `saveFileRef` / `getFileRef` / `incrementFileRef` / `decrementFileRef` | 文件引用计数；`decrement` 到 0 自动清理 manifest + 所有 chunk |
| `saveRecommendation` / `getRecommendation` / `deleteRecommendation` / `listRecommendations` | 推荐记录（keyPath=id=`{appId}-{publisherUserId}`） |
| `clearPublishData(namespace)` | 关闭连接并删除整个 IndexedDB 数据库 |

## 五、关键实现细节

### 1. 分块与哈希算法

```
File
 ├── 按 128KB (128 * 1024 字节) 切分（CHUNK_SIZE，源码实际值；README 误写 255KB）
 ├── chunk[0..n-1] -> 每块 SHA-256 -> chunkHash[i] (hex)
 ├── chunkHashes.join("") -> SHA-256 -> fileHash (hex)
 └── manifest = _sign({ fileHash, chunkHashes, fileName, fileSize })
```

- `publish` 使用 `file.slice(start, end)` 流式读取，每块算完立即 `saveChunk`，避免一次性 `file.arrayBuffer()` 爆内存。

### 2. data_publish 协议

所有协议消息 `type: "data_publish"`，通过 `action` 区分：

| 方向 | action / 形式 | 传输 |
|------|--------------|------|
| 请求方 -> 应答方 | `{type:"data_publish", action:"request_manifest", fileHash}` | 文本 relay，raw=true |
| 请求方 -> 应答方 | `{type:"data_publish", action:"request_chunk", chunkHash}` | 文本 relay，raw=true |
| 应答方 -> 请求方（manifest 存在） | 直接发送 manifest 对象（无 type/action，靠结构特征识别） | 文本 relay |
| 应答方 -> 请求方（manifest 不存在） | `{type:"data_publish", action:"manifest_response", fileHash, error:"not_found"}` | 文本 relay |
| 应答方 -> 请求方（chunk 存在） | 发送 chunk 原始 ArrayBuffer | **二进制 relay** |
| 应答方 -> 请求方（chunk 不存在） | `{type:"data_publish", action:"chunk_response", chunkHash, error:"not_found"}` | 文本 relay |

**二进制 chunk 识别**：二进制 relay 帧的 header 不携带 `chunkHash`，接收方收到二进制后**重新计算 SHA-256**，与当前请求的 `chunkHash` 比对，匹配即为响应。

**manifest 识别**：`isManifest(obj)` 判定 -- 对象、非数组、无 `type` 字段、含 `fileHash`(string) + `chunkHashes`(array) + `signature`(string) + `publicKey`(string)。

### 3. 消息路由（start 内部）

```
user "message" 事件
  └── #handleMessage(detail)
        ├── detail.data 非 string -> 跳过（二进制由 requestChunk 的 remoteUser 监听器处理）
        ├── JSON.parse -> parsed.type === "relay" 才处理
        ├── parsed.data 是 manifest -> #handleManifestResponse（验签存 DB，resolve 请求）
        ├── parsed.data.type === "data_publish"
        │     ├── action="request_manifest" -> #handleRequestManifest（查 DB 回复）
        │     ├── action="request_chunk"    -> #handleRequestChunk（查 DB 回复二进制/错误）
        │     └── action="manifest_response"-> #rejectManifestRequest（错误响应）
        └── chunk_response 错误同时分发到 RemoteUser，由 requestChunk 处理
```

### 4. 请求-响应匹配与并发去重

- `#manifestRequestMap: Map<fileHash, {resolve, reject, timer, promise, unbind}>` -- manifest 请求去重与超时（10s）。
- `#chunkRequestMap: Map<chunkHash, Promise>` -- chunk 请求去重；每次重试重新检查避免复用失败 Promise。
- `#sessionIdCache: Map<remoteUser, {sessionId, promise}>` -- sessionId 首次获取后缓存；`#invalidateSessionCache` 在 session 断开时清理；并发场景共享同一 Promise。

### 5. 自动重试

`requestManifest` / `requestChunk` 各有 2 次尝试：首次失败且错误含 `"disconnected"` 时，`#invalidateSessionCache` 清缓存 + `sessionId = null`，重试自动重新获取会话。

### 6. 应用发布流程

```
createRelease(handle, {appName, version})
  ├── handle.flat() -> 所有文件
  ├── 每文件 getFileHash -> { fileHash, size }
  ├── appId = sha256(appName + userId)
  ├── 读旧 published_apps 记录（升级场景）-> #computeDiffSummary(oldManifestHash, newFiles)
  ├── _sign({ appId, appName, version, publisherUserId, previousManifestHash, files })
  └── Object.freeze(ReleaseInfo) + #releaseCache 缓存 fileBlobs

publish(release)
  ├── verifyData(manifest)  ← 防篡改
  ├── 逐文件：getFileHash 复核 -> DataPublisher.publish(blob) -> incrementFileRef(fileHash, appId)
  ├── manifest 自身作为文件 publish -> manifestHash -> incrementFileRef
  └── savePublishedApp({ appId, appName, version, manifestHash, status:"published", ... })
```

**版本链**：`previousManifestHash` 指向上一个已发布 manifest 的 fileHash，形成哈希链可追溯历史。

### 7. 应用安装/升级流程

```
installApp(manifest, {publisherUser?})
  ├── verifyData(manifest)
  ├── apps/{appName}-{appId}/ 目录
  ├── 读旧 asset-manifest.json（升级场景）
  ├── 遍历新 files：
  │     ├── hash 相同且旧文件存在 -> 跳过（增量）
  │     └── 否则 DataPublisher.fetchFile(publisherUser, fileHash) -> 写入
  ├── 删除旧版有但新版没有的文件
  └── 写入 asset-manifest.json
```

### 8. 文件引用计数

```
publish: incrementFileRef(fileHash, appId)  -> refCount +1, appIds.push(appId)
decrementFileRef(fileHash, appId):
  -> refCount -1
  -> refCount === 0 -> 删 manifest + 所有 chunk + file_refs 记录
```

> 注：当前 `unpublishApp` 仅改状态，不触发 `decrementFileRef`（注释说明"可重新上架"）。

## 六、IndexedDB Schema（db.js）

- 数据库名：`nos_publish_data_${namespace}`（**每 namespace 独立库**）
- `DB_VERSION = 2`

| 仓库 | 版本 | key / keyPath | value |
|------|------|---------------|-------|
| `file_chunks` | v1 | key=chunkHash | ArrayBuffer（块原始二进制） |
| `file_manifests` | v1 | key=fileHash | manifest 对象（含签名） |
| `published_apps` | v2 | keyPath=appName | `{appId, appName, version, manifestHash, publisherUserId, status, publishedAt, updatedAt}` |
| `file_refs` | v2 | keyPath=fileHash | `{fileHash, refCount, appIds:[]}` |
| `recommendations` | v2 | keyPath=id | `{id, appId, appName, publisherUserId, recommendedAt}` |

- `dbCache: Map<namespace, Promise<IDBDatabase>>` -- 连接按 namespace 缓存。
- `clearPublishData(namespace)` 先关闭缓存连接再 `indexedDB.deleteDatabase`。

## 七、依赖关系

| 依赖 | 用途 |
|------|------|
| `../user/main.js` (LocalUser) | `_sign` 签名、`bind("message")` 监听、`server.relayToUserViaServer` 中继回复 |
| `../user/remote-user.js` (RemoteUser) | `send(sid, data, true)` raw 发送、`bind("message")` 接收二进制、`getSessionIds()` |
| `../crypto/crypto-verify.js` (`verifyData`) | manifest 验签 |
| `../util/hash/get-hash.js` (`getHash`) | chunk/file 哈希 |
| `../util/hash/get-file-hash.js` (`getFileHash`) | 应用文件哈希 |
| `../fs/handle/main.js` (`init`) | 应用安装目录 `apps/{appName}-{appId}/` |
| `../fs/handle/dir.js` (DirHandle) | `flat()` 遍历应用文件 |

## 八、与其他模块的联动

| 本模块行为 | 调用方向 | 对端模块 |
|-----------|---------|---------|
| 签名 manifest | -> `LocalUser._sign` | nos/user |
| 验签 manifest | -> `verifyData` | nos/crypto |
| 请求/响应中继 | -> `RemoteUser.send(raw=true)` / `server.relayToUserViaServer` | nos/user |
| 二进制 chunk 传输 | 复用 nos/user 的二进制 relay 帧 `[4B header_len BE][header JSON][payload]` | nos/user + server/rust |
| 应用安装 | -> `init("apps")` + DirHandle | nos/fs |
| 获取发布者 | -> `LocalUser.connectUser` | nos/user |

## 九、与 README 的对应关系

README 中的数值已与源码对齐：

| 项 | 值 | 说明 |
|----|----|------|
| CHUNK_SIZE | 128KB（`128 * 1024`） | data-publisher.js 中的 `CHUNK_SIZE` 常量 |
| 数据库名 | `nos_publish_data_${namespace}` | 按 namespace 隔离，每用户独立库 |
| DB_VERSION | 2 | v1: chunks/manifests；v2: published_apps/file_refs/recommendations |
