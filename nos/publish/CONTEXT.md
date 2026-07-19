# nos/publish 发布模块上下文

> 本文档供 AI 阅读，用于快速理解 `nos/publish` 模块的整体架构与实现细节，无需逐文件阅读源码即可进行代码更新。
> 本模块依赖 `nos/user`（身份/签名/中继），是去中心化数据分发层。

## 一、整体架构

`nos/publish` 提供基于内容寻址（content-addressed）的去中心化数据分发能力。任何持有数据的用户都可响应他人请求，无需中心服务器存储文件内容。

核心模块是 **DataPublisher（数据层）**：将任意 `File/Blob` 按 128KB 分块，每块 SHA-256 哈希，构建经发布者私钥签名的 manifest，通过中继通道在用户间请求/响应 chunk 与 manifest。

### 核心设计

1. **内容寻址**：`chunkHash = SHA-256(chunkData)`；`fileHash = SHA-256(chunkHashes.join(""))`。相同内容必然产生相同哈希，天然去重。
2. **签名清单**：manifest 由 `LocalUser._sign()` 签名；接收方 `verifyData()` 验签后才存入 DB，防篡改。
3. **自适应双通道**：请求方通过 `remoteUser.send(sid, msg, true)` 发送，`RemoteUser.send` 内部按 DataChannel 就绪状态自动选择 RTC / server relay；响应方**镜像请求来源的通道**回复（`url` 存在则走 `server.relayToUserViaServer`；`url` 为空则走 `remoteUser.send`）。RTC 就绪后大 chunk 走 P2P 直连，减轻服务器流量；未就绪时自动 fallback 到 relay。
4. **接收端双绑定**：`start()` 同时监听 `LocalUser.message`（server relay）与 `LocalUser.rtc_message`（DataChannel），两者归一到 `#dispatchIncoming`。这是保证 RTC 请求也能被响应的关键 —— 若只绑 `message`，走 RTC 的请求接收端将收不到导致 15s 超时（历史 bug）。
5. **二进制高效传输**：chunk 数据在 server relay 走二进制帧（`relayToUserViaServer` 自动识别），在 RTC 走 `dc.send(ArrayBuffer)`；两条路径都零 base64 开销。
6. **本地优先 + 远程兜底**：所有请求先查本地 IndexedDB，未命中才发起网络请求。
7. **并发去重**：同一 `fileHash`/`chunkHash` 的并发请求自动合并为同一个 Promise。
8. **sessionId 缓存与重试**：首次 `getSessionIds()` 后缓存；当前 session 断开自动失效缓存并重试一次。

## 二、模块地图

```
nos/publish/
├── data-publisher.js    # DataPublisher：文件分块发布/请求/组装
├── db.js                # IndexedDB 持久化（2 个仓库，version 1）
├── README.md            # API 文档（人类阅读，部分数值已过时，以本文档为准）
└── CONTEXT.md           # 本文档
```

## 三、类关系

```
DataPublisher (data-publisher.js)       ← 依赖 LocalUser
  └── 协议处理：start() 监听 user "message" 事件
```

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

### db.js 工具函数

| 函数 | 说明 |
|------|------|
| `saveChunk` / `getChunk` / `deleteChunk` | chunk 存/读/删（key=chunkHash，value=ArrayBuffer） |
| `saveManifest` / `getManifest` / `deleteManifest` | manifest 存/读/删（key=fileHash） |
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
| 请求方 -> 应答方 | `{type:"data_publish", action:"request_manifest", fileHash}` | `remoteUser.send`（RTC 优先，否则 server relay），raw=true |
| 请求方 -> 应答方 | `{type:"data_publish", action:"request_chunk", chunkHash}` | `remoteUser.send`（RTC 优先，否则 server relay），raw=true |
| 应答方 -> 请求方（manifest 存在） | 直接发送 manifest 对象（无 type/action，靠结构特征识别） | 镜像来源通道 |
| 应答方 -> 请求方（manifest 不存在） | `{type:"data_publish", action:"manifest_response", fileHash, error:"not_found"}` | 镜像来源通道 |
| 应答方 -> 请求方（chunk 存在） | 发送 chunk 原始 ArrayBuffer | **二进制**：server relay 二进制帧 / RTC dc.send(ArrayBuffer) |
| 应答方 -> 请求方（chunk 不存在） | `{type:"data_publish", action:"chunk_response", chunkHash, error:"not_found"}` | 镜像来源通道 |

**二进制 chunk 识别**：二进制 relay 帧的 header 不携带 `chunkHash`，接收方收到二进制后**重新计算 SHA-256**，与当前请求的 `chunkHash` 比对，匹配即为响应。

**manifest 识别**：`isManifest(obj)` 判定 -- 对象、非数组、无 `type` 字段、含 `fileHash`(string) + `chunkHashes`(array) + `signature`(string) + `publicKey`(string)。

### 3. 消息路由（start 内部）

`start()` 同时绑定两条入站通道，归一到 `#dispatchIncoming`：

```
LocalUser.message 事件（server relay）              LocalUser.rtc_message 事件（DataChannel）
  └── #handleRelayMessage(detail)                     └── #handleRtcMessage(detail)
        ├── detail.data 非 string -> 跳过                 ├── data 非 string -> 跳过（二进制 chunk 由请求端匹配）
        ├── JSON.parse -> parsed.type === "relay"         ├── JSON.parse
        └── 提取 fromUserId/fromSessionId/detail.url      └── url 置为 null（标识 RTC 来源）
              ↓                                                 ↓
              └───────────► #dispatchIncoming({data, fromUserId, fromSessionId, url}) ◄─┘
                              ├── isManifest(data) -> #handleManifestResponse（验签存 DB，resolve 请求）
                              ├── data.type === "data_publish"
                              │     ├── action="request_manifest" -> #handleRequestManifest
                              │     ├── action="request_chunk"    -> #handleRequestChunk
                              │     └── action="manifest_response"-> #rejectManifestRequest
                              └── chunk_response 错误也会分发到 RemoteUser.message，由请求端 #doRequestChunk 处理
```

`#sendResponse(fromUserId, fromSessionId, url, data)` 是响应端的统一出口：
- `url != null` -> `server.relayToUserViaServer(url, ...)`（沿请求来的服务器返回）
- `url == null` -> `remoteUser.send(sid, data, true)`（走 RTC；若断了自动 fallback 到 server）

**二进制 chunk 响应的接收路径**：`server.relayToUserViaServer(chunkArrayBuffer)` 走 WS 二进制帧 -> `user.js` 解析 -> `RemoteUser.message`（二进制）；`dc.send(ArrayBuffer)` 走 RTC -> `user.js #setupRTCDispatch` -> `RemoteUser.message`（二进制）。两条路径最终都归到请求端 `#doRequestChunk` 的 `remoteUser.bind("message")` 监听器，通过重算 SHA-256 与请求 `chunkHash` 匹配。

### 4. 请求-响应匹配与并发去重

- `#manifestRequestMap: Map<fileHash, {resolve, reject, timer, promise, unbind}>` -- manifest 请求去重与超时（10s）。
- `#chunkRequestMap: Map<chunkHash, Promise>` -- chunk 请求去重；每次重试重新检查避免复用失败 Promise。
- `#sessionIdCache: Map<remoteUser, {sessionId, promise}>` -- sessionId 首次获取后缓存；`#invalidateSessionCache` 在 session 断开时清理；并发场景共享同一 Promise。

### 5. 自动重试

`requestManifest` / `requestChunk` 各有 2 次尝试：首次失败且错误含 `"disconnected"` 时，`#invalidateSessionCache` 清缓存 + `sessionId = null`，重试自动重新获取会话。

## 六、IndexedDB Schema（db.js）

- 数据库名：`nos_publish_data_${namespace}`（**每 namespace 独立库**）
- `DB_VERSION = 1`

| 仓库 | 版本 | key / keyPath | value |
|------|------|---------------|-------|
| `file_chunks` | v1 | key=chunkHash | ArrayBuffer（块原始二进制） |
| `file_manifests` | v1 | key=fileHash | manifest 对象（含签名） |

- `dbCache: Map<namespace, Promise<IDBDatabase>>` -- 连接按 namespace 缓存。
- `clearPublishData(namespace)` 先关闭缓存连接再 `indexedDB.deleteDatabase`。

## 七、依赖关系

| 依赖 | 用途 |
|------|------|
| `../user/main.js` (LocalUser) | `_sign` 签名、`bind("message")` / `bind("rtc_message")` 双通道监听、`server.relayToUserViaServer` 响应回复、`_ensureRemoteUser` 供响应端复用 RemoteUser |
| `../user/remote-user.js` (RemoteUser) | `send(sid, data, true)` 请求发起 / RTC 响应回复、`bind("message")` 匹配二进制 chunk 响应、`getSessionIds()` |
| `../crypto/crypto-verify.js` (`verifyData`) | manifest 验签 |
| `../util/hash/get-hash.js` (`getHash`) | chunk/file 哈希 |

## 八、与其他模块的联动

| 本模块行为 | 调用方向 | 对端模块 |
|-----------|---------|---------|
| 签名 manifest | -> `LocalUser._sign` | nos/user |
| 验签 manifest | -> `verifyData` | nos/crypto |
| 请求发起 | -> `remoteUser.send(raw=true)`（内部选择 RTC / server relay） | nos/user |
| 响应回复 | -> `server.relayToUserViaServer` 或 `remoteUser.send(raw=true)` | nos/user |
| 二进制 chunk 传输 | 复用 nos/user 的二进制 relay 帧 `[4B header_len BE][header JSON][payload]` 或 RTC `dc.send(ArrayBuffer)` | nos/user + server/rust |

## 九、与 README 的对应关系

README 中的数值已与源码对齐：

| 项 | 值 | 说明 |
|----|----|------|
| CHUNK_SIZE | 128KB（`128 * 1024`） | data-publisher.js 中的 `CHUNK_SIZE` 常量 |
| 数据库名 | `nos_publish_data_${namespace}` | 按 namespace 隔离，每用户独立库 |
| DB_VERSION | 1 | chunks/manifests |
