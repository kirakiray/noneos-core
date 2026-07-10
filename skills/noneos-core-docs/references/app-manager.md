# NoneOS Core 应用发布管理 API 参考

> ⚠️ **实验性 API（Experimental）**：AppManager 目前处于试验阶段，API 与数据结构可能在后续版本中发生**破坏性变更甚至被整体移除**。请勿在生产环境中依赖此模块，使用前务必关注版本更新说明。

AppManager 是基于 DataPublisher 的应用发布管理模块，提供应用的创建、发布、发现、安装、升级、下架和推荐功能。

## 概述

### 核心流程

1. **发布端**：`createRelease` 预览 → `publish` 正式发布
2. **消费者端**：`fetchManifest` 获取清单 → `installApp` 安装
3. **维护**：`checkForUpdates` 检测更新 → `installApp` 增量升级

### 特性

- **签名保障**：每个应用的 asset-manifest.json 由发布者私钥签名，安装时验签，防止篡改
- **分步发布**：`createRelease` 预览确认 → `publish` 真正发布，防误操作
- **版本链**：manifest 通过 `previousManifestHash` 形成哈希链，追溯版本历史
- **增量升级**：升级场景跳过 hash 未变的文件，只拉取有变化的部分
- **文件引用计数**：自动追踪文件引用，unpublish 时无引用则清理
- **推荐机制**：可将已安装的应用推荐给他人，扩展应用发现网络
- **幂等操作**：卸载/下架/取消推荐不存在的内容均静默成功

### 安装目录结构

应用安装到 `apps/` 目录下，格式为 `{appName}-{appId}`：
```
apps/
  my-app-<sha256(appName + userId)>
    index.html
    app.js
    asset-manifest.json
```

通过 `/$apps/{appName}-{appId}/` 可直接访问安装后的文件。

---

## 初始化

### new AppManager() - 创建管理器

```javascript
import { getUser } from "/nos/user/main.js";
import { AppManager } from "/nos/publish/app-manager.js";

const user = await getUser("my-namespace");
const manager = new AppManager(user);
```

### start() / stop() - 启动/停止监听

```javascript
manager.start(); // 启动内部 DataPublisher 监听
// ...
manager.stop();  // 停止监听
```

---

## 发布应用

### createRelease() - 创建发布候选（预览）

遍历虚拟目录的所有文件，计算 fileHash，构建并签名 asset-manifest.json。

```javascript
import { init } from "/nos/fs/handle/main.js";

const handle = await init("my-app-dir");

const release = await manager.createRelease(handle, {
  appName: "my-app",
  version: "0.1.0",
});

// release 结构：
{
  manifest: {
    appId: "sha256(appName + userId)",
    appName: "my-app",
    version: "0.1.0",
    publisherUserId: "...",
    previousManifestHash: null, // 升级时为上一个 manifest 的 hash
    files: {
      "index.html": { fileHash: "sha256-xxx", size: 1024 },
      "src/app.js": { fileHash: "sha256-yyy", size: 2048 },
    },
    signTime: 1234567890,
    publicKey: "...",
    signature: "base64...",
  },
  diffSummary: null,            // 升级场景下为变更摘要
  fileCount: 2,
  totalSize: 3072,
}
```

**升级场景的 diffSummary：**
```javascript
{
  added:    { "new.js": { fileHash: "...", size: 500 } },
  modified: { "index.html": { oldHash: "...", newHash: "...", oldSize: 10, newSize: 20 } },
  removed:  { "old.txt": { fileHash: "...", size: 100 } },
  sizeDelta: 410,
}
```

### publish() - 正式发布

验签 → 逐个 publish 文件（验证 hash）→ publish manifest → 更新 DB 记录和引用计数。

```javascript
const result = await manager.publish(release);
// { appId, appName: "my-app", version: "0.1.0", publishedAt: 1234567890 }
```

**安全机制：**
- `publish()` 内部会重新验签，篡改 `release.manifest` 会被拒绝
- 每个文件会重新计算 fileHash 与 manifest 比对，不一致则报错
- 发布完成后清理内部缓存，ReleaseInfo 不可重复使用

---

## 发现应用

### discoverApps() - 发现已发布的应用

```javascript
// 查询指定发布者
const apps = await manager.discoverApps({
  publisherUserId: "user-xxxxx",
});
// apps: [{ appId, appName, version, publisherUserId, publishedAt }]
```

### fetchManifest() - 获取应用清单

```javascript
const manifest = await manager.fetchManifest(appId);
if (manifest) {
  console.log("应用版本:", manifest.version);
  console.log("文件列表:", Object.keys(manifest.files));
}
```

未找到时返回 `null`（应用已下架或不存在）。

---

## 安装应用

### installApp() - 安装或升级

写入路径为 `apps/{appName}-{appId}/`。

```javascript
// 基本安装
await manager.installApp(manifest);

// 从远程用户获取（用于首次安装且本地无缓存）
await manager.installApp(manifest, {
  publisherUser: remoteUser, // RemoteUser 实例
});
```

**升级场景增量逻辑：**
1. 检测到 `apps/{appName}-{appId}/` 已存在
2. 读取旧 `asset-manifest.json` 对比 files
3. fileHash 相同的文件跳过（不拉取）
4. fileHash 不同的文件重新拉取覆写
5. 删除旧版有但新版没有的文件
6. 写入新 `asset-manifest.json`

---

## 更新检查

### checkForUpdates() - 检查单个更新

```javascript
const update = await manager.checkForUpdates(appId);

if (update === null) {
  // 未安装该应用
} else if (update.hasUpdate === false) {
  // 已是最新版本
} else {
  // 有可用更新
  console.log(`${update.currentVersion} → ${update.latestVersion}`);
  console.log("变更摘要:", update.diffSummary);
  console.log("新 manifest:", update.manifest);
}
```

### checkAllUpdates() - 批量检查所有

```javascript
const updates = await manager.checkAllUpdates();
// 返回所有有可用更新的 UpdateInfo 数组
for (const u of updates) {
  if (u.hasUpdate) {
    console.log(`${u.appName}: ${u.currentVersion} → ${u.latestVersion}`);
  }
}
```

---

## 本地已安装管理

### listInstalledApps() - 列出已安装应用

```javascript
const installed = await manager.listInstalledApps();
// [{ appId, appName, version, publisherUserId }]
```

### getInstalledAppInfo() - 获取已安装应用的 manifest

```javascript
const manifest = await manager.getInstalledAppInfo("my-app");
if (manifest) {
  console.log("版本:", manifest.version);
  console.log("签名:", manifest.signature);
}
```

### uninstallApp() - 卸载应用

```javascript
await manager.uninstallApp("my-app");
// 幂等，应用不存在则静默成功
```

---

## 自身发布管理

### listMyPublishedApps() - 列出自己发布的应用

```javascript
const myApps = await manager.listMyPublishedApps();
// [{ appId, appName, version, publisherUserId, publishedAt }]
```

### unpublishApp() - 下架应用

```javascript
await manager.unpublishApp("my-app");
```

**行为说明：**
- 仅将 DB 中的状态改为 `"unpublished"`
- 不下架 DataPublisher 中的文件数据
- 其他人已安装的应用不受影响
- 可通过 `publish()` 重新上架（检测到 `unpublished` 状态会自动转为 `published`）

---

## 推荐

### recommendApp() - 推荐应用

```javascript
await manager.recommendApp(appId, publisherUserId);
```

将本地已安装的别人发布的应用推荐出去。当其他人调用 `discoverApps({ publisherUserId: myUserId })` 时，可以同时看到我推荐的应用。重复推荐自动跳过。

### unrecommendApp() - 取消推荐

```javascript
await manager.unrecommendApp(appId, publisherUserId);
// 幂等，推荐不存在则静默成功
```

---

## 数据模型

### asset-manifest.json 结构

```json
{
  "appId": "sha256(appName + publisherUserId)",
  "appName": "my-app",
  "version": "0.1.0",
  "publisherUserId": "user-xxxx",
  "previousManifestHash": null,
  "files": {
    "index.html": { "fileHash": "sha256-xxx", "size": 1024 }
  },
  "signTime": 1234567890,
  "publicKey": "MIIBIjANBgkqhkiG9w0BAQ...",
  "signature": "base64..."
}
```

### appId 计算

`appId = sha256(appName + publisherUserId)`

保证全局唯一，不同用户即使发布同名 app，appId 也不同。

### 版本历史链

每个 manifest 中的 `previousManifestHash` 指向上一个版本的 manifest 的 fileHash，形成防篡改链：

```
v1: { version:"0.1.0", previousManifestHash: null, signed }
        ↓ (manifestHash)
v2: { version:"0.2.0", previousManifestHash: "hash(v1)", signed }
        ↓
v3: { version:"0.3.0", previousManifestHash: "hash(v2)", signed }
```

每个版本独立签名，插入/删除/重排序都会导致链断裂。

---

## 与 DataPublisher 的关系

| 功能 | DataPublisher | AppManager |
|------|---------------|------------|
| 文件分块存储 | ✅ 核心功能 | 内部使用 |
| 文件发布 | ✅ `publish(file)` | 通过 DataPublisher.publish 间接发布 |
| 文件获取 | ✅ `fetchFile()` | 通过 DataPublisher.fetchFile 间接获取 |
| manifest 签名 | ✅ 文件级 | ✅ 应用级（asset-manifest.json） |
| 应用版本管理 | ❌ | ✅ |
| 应用发现 | ❌ | ✅ |
| 安装/升级 | ❌ | ✅ |
| 推荐机制 | ❌ | ✅ |

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

## 测试覆盖

AppManager 的测试用例位于 `tests/publish/app-publisher.sb.html`，覆盖以下场景：

| # | 测试名 | 验证内容 |
|---|--------|---------|
| 1 | createRelease | 遍历目录 → 签名 manifest → appId/fileCount/relative paths |
| 2 | publish | 发布 → DB 记录存在 → 状态/版本/AppId 正确 |
| 3 | publish 防篡改 | 改 manifest.version → 签名验证拒绝 |
| 4 | discoverApps | 发布后列表包含对应应用 |
| 5 | fetchManifest | 按 appId 获取 → 结构与发布时一致 + 不存在的 appId 返回 null |
| 6 | 升级 diffSummary | v1→v2 时能正确识别 added/modified/removed 文件 |
| 7 | installApp | 安装后目录存在、文件内容正确、manifest 写入正确 |
| 8 | checkForUpdates | 刚安装无更新 → 发布 v2 后检测到更新 |
| 9 | checkAllUpdates | 安装 2 个应用 → 批量检查 → 升级其一后再次检查 |
| 10 | listInstalledApps / getInstalledAppInfo / uninstallApp | 列出/查询/卸载/幂等 |
| 11 | listMyPublishedApps / unpublishApp | 列表/下架/下架后不显示/幂等 |
| 12 | recommendApp / unrecommendApp | 推荐/列表/去重/取消推荐/幂等 |

## 常见问题

### 发布后如何更新版本？

```javascript
// 修改 handle 目录下的文件后
const newRelease = await manager.createRelease(handle, {
  appName: "my-app",      // 同一 appName = 升级
  version: "0.2.0",       // 更新版本号
});
// newRelease.diffSummary 自动包含变更摘要
await manager.publish(newRelease);
```

### 如何让应用在 /$apps/ 下可访问？

安装应用后自动写入 `apps/{appName}-{appId}/`，NoneOS Core 会自动将 `/$apps/` 路由映射到该目录。无需额外配置。

### unpublish 后数据还在吗？

在。只是下架（改状态），DataPublisher 中的文件数据不删除。可通过 `publish()` 重新上架。

### 如何安全地彻底删除应用及数据？

先 `unpublishApp` 下架（让别人无法发现），再通过 DataPublisher 的底层 API 清理文件数据（当前版本暂未暴露自动清理接口）。
