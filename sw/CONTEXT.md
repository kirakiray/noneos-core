# sw Service Worker 模块上下文

> 本文档供 AI 阅读，用于快速理解 `sw` 模块的整体架构与实现细节，无需逐文件阅读源码即可进行代码更新。

## 一、整体架构

`sw` 是 NoneOS Core 的浏览器端 Service Worker，负责拦截页面发起的网络请求，并按路径前缀代理到不同的数据源。它在本地调试、离线缓存、远端 CDN 与挂载目录之间提供统一的资源访问层。

### 核心设计

1. **统一拦截**：通过 `fetch` 事件监听同域及 `core.noneos.com` 的请求，按路径前缀分发到对应处理器。
2. **多级缓存策略**：
   - `/nos/` 资源支持在线模式（直接 fetch）与本地模式（优先 OPFS 缓存，回退 fetch）。
   - `/gh/`、`/npm/`、`/ncomp/` 资源统一使用 SWR + 内存 TTL 策略（见 `cache-handlers.js`）。
   - `/\$/`、`/\$mount-/` 资源直接读取本地 OPFS / 挂载目录。
3. **宿主项目离线缓存**：通过 `host-cache-handler.js`，使用 noneos-core 的项目可声明 manifest 文件列表，SW 在后台预缓存这些文件。fetch 时：开发环境（localhost）旁路 OPFS 直接走网络；生产环境采用 SWR（命中缓存立即返回 + 后台刷新，下次刷新生效）。仅在宿主项目设置 `globalThis.HOST_CACHE_CONFIG` 时启用。
4. **调试模式透传**：`localhost:3002` 调试环境下，`/nos/` 与 `/nos-tool/` 请求直接走网络；`/ncomp/` 请求切换为"网络优先"，代理到 `localhost:3002`，失败时回退官方源和缓存。
5. **动态配置**：通过 `/__config` 与激活后的 `reloadSystemConfig()` 读取 OPFS 中的 `nos-config/system.json`，热更新 `systemConfig`。

## 二、模块地图

```
sw/
├── src/
│   ├── main.js                  # Service Worker 入口：fetch 事件分发与配置加载
│   └── modules/
│       ├── nos-handle.js        # /nos/ 资源代理（线上 / OPFS 本地缓存）
│       ├── nostool-handle.js    # /nos-tool/ 资源代理（调试模式透传、官方源回退）
│       ├── cache-handlers.js    # /gh/ /npm/ /ncomp/ 统一 SWR 处理器
│       ├── host-cache-handler.js # 宿主项目离线缓存（预缓存、fetch fallback、版本管理）
│       ├── file-handler.js      # /\$/ 本地 OPFS 文件代理
│       ├── mount-handle.js      # /\$mount-{id}>/ 挂载目录文件代理
│       ├── file-system.js       # OPFS 根目录与文件句柄工具
│       └── mime-types.js        # 扩展名到 Content-Type 的映射
├── dist.js                      # Rollup 构建产物（未压缩）
├── dist.min.js                  # Rollup 构建产物（压缩）
└── CONTEXT.md                   # 本文档
```

## 三、类/函数关系

```
sw/src/main.js
├── handleNosRequest          (modules/nos-handle.js)
├── handleNosToolRequest      (modules/nostool-handle.js)
├── handleGitHubRequest       (modules/cache-handlers.js)
├── handleNpmRequest          (modules/cache-handlers.js)
├── handleNcompRequest        (modules/cache-handlers.js)
├── handleMountRequest        (modules/mount-handle.js)
├── handleFileRequest         (modules/file-handler.js)
├── handleHostCacheRequest    (modules/host-cache-handler.js)  # fetch fallback
├── handleHostCacheStatus     (modules/host-cache-handler.js)  # /__host-cache 路由
├── triggerHostCacheUpdate    (modules/host-cache-handler.js)  # /__update-host-cache 路由
├── handleHostCacheMessage    (modules/host-cache-handler.js)  # postMessage 处理
├── initHostCache             (modules/host-cache-handler.js)  # SW 加载时初始化
└── isHostCachedFile          (modules/host-cache-handler.js)  # 同步路径检查
    └── getFileHandle         (modules/file-system.js)
```

## 四、关键 API

### 入口层（main.js）

| 事件/函数 | 说明 |
|-----------|------|
| `fetch` 事件监听 | 拦截同域及 `core.noneos.com` 请求（默认 `core.noneos.com`，可通过 `globalThis.SERVER_OPTIONS.coreHostName` 覆盖），按前缀路由 |
| `/__config` 路径 | 特殊路由：触发 `reloadSystemConfig()` 并返回 `{ serviceWorkerVersion, systemConfig }` JSON；`serviceWorkerVersion` 来自 `NONEOS_CORE_VERSION` 常量（如 `"noneos-core@4.2.3"`，去掉前缀后输出） |
| `/__host-cache` 路径 | 特殊路由（仅在 `globalThis.HOST_CACHE_CONFIG` 设置时生效）：返回当前 host-cache 状态 JSON `{ name, version, fileCount, precaching }` |
| `/__update-host-cache` 路径 | 特殊路由（仅在 `globalThis.HOST_CACHE_CONFIG` 设置时生效）：触发 host-cache 更新，SW 自行拉取最新 manifest 并预缓存，返回更新结果 JSON |
| `message` 事件 | 监听 `host-cache-update` 消息，触发宿主项目缓存更新流程；完成后回复 `host-cache-update-result` |
| `install` | `skipWaiting()` 立即激活 |
| `activate` | `clients.claim()` 接管页面，1s 后刷新配置 |
| `reloadSystemConfig()` | 从 OPFS `nos-config/system.json` 读取 `systemConfig`；失败返回 500 状态码 |
| `initHostCache()` | SW 脚本加载时触发（文件末尾）；从 OPFS 加载持久化 manifest，再从网络拉取最新版本，版本变化时触发预缓存 |
| 初始加载 | SW 脚本加载时（文件末尾）也会立即同步触发一次 `reloadSystemConfig()`，不等 activate |

### 路径路由表

> **匹配顺序**：按表中从上到下顺序匹配；`/__config` 与 `/__host-cache` 最先短路；`/$mount-/` 必须在 `/$/` 之前；host-cache fallback 在所有 noneos-core 路由之后。

| 路径前缀 | 处理器 | 说明 |
|----------|--------|------|
| `/__config` | (main.js 内联) | 特殊路由，触发配置重载并返回 JSON |
| `/__host-cache` | `host-cache-handler.js` | 特殊路由，返回 host-cache 状态 JSON（需 `HOST_CACHE_CONFIG`） |
| `/__update-host-cache` | `host-cache-handler.js` | 特殊路由，触发 host-cache 更新，返回结果 JSON（需 `HOST_CACHE_CONFIG`） |
| `/nos-tool/` | `nostool-handle.js` | nos-tool 资源代理；调试模式直接 fetch，否则回退官方源 |
| `/ncomp/` | `cache-handlers.js` | ncomp 公共组件；生产环境 SWR，dev（localhost）网络优先，多源候选 |
| `/nos/` | `nos-handle.js` | nos 核心资源代理；支持 online / local 模式，调试模式直接 fetch |
| `/gh/` | `cache-handlers.js` | GitHub 仓库文件代理，映射到 jsDelivr |
| `/npm/` | `cache-handlers.js` | NPM 包文件代理，映射到 jsDelivr NPM CDN |
| `/\$mount-/` | `mount-handle.js` | 本地挂载目录文件代理；URL 形态 `/$mount-{id}>/{相对路径}`，id 通过正则 `/\$mount\-(.+)>.+/` 提取 |
| `/\$/` | `file-handler.js` | 本地 OPFS 文件代理；命中时返回带正确 `Content-Type` 头的 Response |
| (fallback) | `host-cache-handler.js` | 同域 GET 请求且路径在 manifest files 列表中时返回缓存（需 `HOST_CACHE_CONFIG`）。**开发环境（localhost / 127.0.0.1）旁路 OPFS 直接走网络**；生产环境采用 SWR：命中缓存立即返回，TTL 过期后台刷新覆盖 OPFS（下次刷新生效），未命中同步回退网络并写入缓存 |

### 通用工具

| 函数 | 文件 | 说明 |
|------|------|------|
| `getRootDirectory()` | `file-system.js` | 缓存并返回 `navigator.storage.getDirectory()` |
| `getFileHandle({ path, create })` | `file-system.js` | 按 `/` 分割路径，逐级定位 OPFS 文件句柄 |
| `getContentType(path)` | `mime-types.js` | 根据扩展名返回 MIME Type |

## 五、关键实现细节

### 1. `/nos/` 资源代理策略（nos-handle.js）

- **`localhost:3002` 调试模式**：直接 `fetch(request)`，不读取 `systemConfig`，避免加载 OPFS 中的旧缓存。
- **其他 `localhost:*` 调试模式**（例如页面在 `localhost:3003` 但通过 `importScripts("http://localhost:3002/sw/dist.js")` 加载本 SW）：优先将 `/nos/` 请求 URL 的端口替换为 `3002`，代理到 `localhost:3002` 的在线资源；若 `localhost:3002` 未启动，则继续走默认的 online/local 处理路线。
- **`systemConfig.mode === "online"` 或未配置**：直接 `fetch(request)` 请求线上资源。
- **`systemConfig.mode === "local"`**：将 `/nos/` 替换为 `systemConfig.nosMapPath + "/"`，优先从 OPFS 读取；若文件不存在或为空，回退 `fetch(request)`。

### 2. `/nos-tool/` 资源代理策略（nostool-handle.js）

- **`localhost:3002`**：直接 `fetch(request)` 返回本地调试服务器资源。
- **其他 `localhost:*`**：将请求端口替换为 `3002` 再 fetch，失败则回退官方源。
- **非本地环境**：请求 `https://core.noneos.com/` 对应路径。

### 3. `/gh/` `/npm/` `/ncomp/` 统一 SWR 策略（cache-handlers.js）

三者共用同一个 `createHandler` 工厂，共享同一份模块级状态（`lastRefreshAt: Map` 与 `refreshing: Set`）。

**核心机制**：
- **缓存命中 & TTL < 5 分钟**：直接返回缓存，无网络请求。
- **缓存命中 & TTL 过期或无记录**：立即返回旧缓存，后台异步刷新。
  - 后台刷新有 `navigator.onLine` 守卫（离线跳过）和 `refreshing: Set` 去重（并发合并）。
  - 过期条目在检测到时立即从 `lastRefreshAt` 中删除，实现内存自动回收。
- **缓存未命中**：同步按候选源顺序 fetch，写盘后返回。
- **网络优先模式**（`networkFirstWhen` 返回 true 时启用）：始终先尝试网络，失败才回退缓存。

**每个 handler 的差异只有两个参数**：
- `resolveSources({ path, request })`：返回按优先级排列的候选源 URL 数组。
- `networkFirstWhen({ path, request })`：可选，返回 true 时启用网络优先。

**具体路径映射**：
- `/gh/{path}` → `https://cdn.jsdelivr.net/gh/{path}`（单源，SWR）
- `/npm/{path}` → `https://cdn.jsdelivr.net/npm/{path}`（单源，SWR）
- `/ncomp/{path}` → 生产环境走 `https://core.noneos.com/...`（SWR）；localhost dev 环境启用网络优先，候选源依次为 `localhost:3002` → 官方源 → 同域兜底。

### 4. `/\$/` 本地文件代理（file-handler.js）

- 去除前缀 `/\$` 后作为 OPFS 路径读取文件。
- 文件不存在或为空返回 404。

### 5. `/\$mount-{id}>/` 挂载目录代理（mount-handle.js）

- 从 IndexedDB 加载已持久化的挂载句柄（复用 `nos/fs/handle/mount/db.js`）。
- 按挂载根目录后的相对路径逐级定位文件；目录 URL 自动补全 `index.html`。
- 失败返回 400 并附带错误堆栈。

### 6. 配置热更新

- `systemConfig` 初始为空对象，SW 脚本加载时与 activate 后 1s 各触发一次加载。
- `/__config` 请求触发 `reloadSystemConfig()` 并返回当前版本与配置；读取失败返回 500。
- 配置存储在 OPFS `nos-config/system.json` 中，由 `nos-tool/_install/main.js` 的 `updateSystemConfig()` 通过 `nos/fs` 句柄 API 写入（nos-tool 等上层应用通过触发安装流程间接写入）。

### 7. 宿主项目离线缓存（host-cache-handler.js）

允许使用 noneos-core 的项目（如 Mazmot）通过 manifest 文件声明需要离线缓存的文件列表。仅在宿主项目 `sw.js` 中设置 `globalThis.HOST_CACHE_CONFIG` 时启用。

**启用方式**（宿主项目 sw.js）：
```javascript
globalThis.HOST_CACHE_CONFIG = true; // 或 { manifestPath: "/host-cache.json" }
importScripts("https://core.noneos.com/sw/dist.js");
```

**Manifest 格式**（默认路径 `/host-cache.json`）：
```json
{ "name": "mazmot", "version": "1.0.14", "files": ["index.html", "main.js", ...] }
```

**OPFS 存储结构**：
```
host-cache/
  manifest.json    # 持久化的 manifest
  files/           # 缓存文件，保持原始路径结构
```

**核心流程**：
- **初始化**（`initHostCache`）：SW 加载时先从 OPFS 读取持久化 manifest 恢复内存状态，再从网络拉取最新 manifest。版本变化时触发 `updateHostCache`。
- **预缓存**（`updateHostCache`）：删除不再需要的旧文件，然后逐个下载 manifest 中的所有文件写入 OPFS `host-cache/files/`。完成后持久化 manifest。通过 `postMessage` 向 client 广播进度（`host-cache-progress`）和完成事件（`host-cache-complete`）。
- **fetch 拦截**：作为所有 noneos-core 路由之后的 fallback。同域 GET 请求且路径在 files 列表中时进入 host-cache 处理。
  - **开发环境旁路**：`self.location.hostname` 为 `localhost` 或 `127.0.0.1` 时，`isHostCachedFile` 直接返回 false，旁路整个 OPFS 缓存层，请求走网络，确保宿主项目源码改动无需 bump version 即可立即生效。
  - **生产环境 SWR**：命中 OPFS 缓存立即返回（保证响应速度），同时若距上次后台刷新超过 `SWR_TTL`（5 分钟），异步 `fetch(request, { cache: "no-store" })` 拉取最新内容覆盖 OPFS。后台刷新带 `navigator.onLine` 守卫与 `refreshing: Set` 去重。**下次刷新即可拿到新版本**——无需 bump version，生产环境也能在 5 分钟内自愈陈旧缓存。缓存未命中时同步回退网络并写入缓存。
- **版本更新触发**：前端 fetch `/__host-cache` 获取当前缓存版本，与最新 manifest 版本对比，发现差异后通过 `postMessage({ type: "host-cache-update", manifest })` 通知 SW 执行更新。
- **manifest 文件本身不走缓存**：始终从网络获取，确保前端能检测到版本变化。

**导出 API**：
| 函数 | 说明 |
|------|------|
| `initHostCache()` | SW 加载时调用，初始化 host-cache 状态 |
| `isHostCachedFile(path)` | 同步检查路径是否在缓存列表中（用于 main.js 路由判断） |
| `handleHostCacheRequest({ path, request })` | 处理 fetch 请求，返回缓存或回退网络 |
| `handleHostCacheStatus()` | 返回当前 host-cache 状态 JSON |
| `triggerHostCacheUpdate()` | 触发更新流程（SW 自行拉取 manifest），返回结果 JSON Response |
| `handleHostCacheMessage(data)` | 处理 `host-cache-update` postMessage |
| `updateHostCache(manifest)` | 执行预缓存更新流程 |

## 六、依赖关系

- `nos/fs/handle/mount/db.js` —— 挂载目录持久化句柄加载
- 浏览器 API：`ServiceWorkerGlobalScope`、`navigator.storage.getDirectory()`、`fetch`、`Response`、`IndexedDB`（被 mount/db.js 用于持久化 FileSystemHandle）

## 七、构建说明

- 源码使用 ES Modules 编写，通过 Rollup 打包为 `sw/dist.js` 与 `sw/dist.min.js`（以及对应的 `.map` sourcemap 文件）。
- 构建命令：`npm run build:sw`；开发模式可使用 `npm run watch:sw`（监听 `sw/src/**` 自动重建）。
- **SW 注册链路**：`nos-tool/_install/main.js`（生产）或 `nos-tool/_install/register.js`（测试/快速）→ `registerSw("sw.js")` → `nos-tool/_install/util.js` 调用 `navigator.serviceWorker.register("/sw.js")` → 根目录 `/sw.js` 执行 `importScripts("/sw/dist.js")`。**注意：实际加载的是未压缩的 `dist.js`，不是 `dist.min.js`**。
- 修改 `sw/src/` 后必须重新构建，否则线上运行的 Service Worker 不会生效。
