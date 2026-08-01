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
3. **调试模式透传**：`localhost:3002` 调试环境下，`/nos/` 与 `/nos-tool/` 请求直接走网络；`/ncomp/` 请求切换为"网络优先"，代理到 `localhost:3002`，失败时回退官方源和缓存。
4. **动态配置**：通过 `/__config` 与激活后的 `reloadSystemConfig()` 读取 OPFS 中的 `nos-config/system.json`，热更新 `systemConfig`。

## 二、模块地图

```
sw/
├── src/
│   ├── main.js                  # Service Worker 入口：fetch 事件分发与配置加载
│   └── modules/
│       ├── host-cache-handle.js  # 宿主项目缓存代理（OPFS 读取 + 路径 Set 拦截）
│       ├── nos-handle.js        # /nos/ 资源代理（线上 / OPFS 本地缓存）
│       ├── nostool-handle.js    # /nos-tool/ 资源代理（调试模式透传、官方源回退）
│       ├── cache-handlers.js    # /gh/ /npm/ /ncomp/ 统一 SWR 处理器
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
│   └── getFileHandle         (modules/file-system.js)
├── handleHostCacheRequest     (modules/host-cache-handle.js)   ← fetch 链末尾兜底
├── hasHostCachePath           (modules/host-cache-handle.js)   ← 路径匹配判断
└── initHostCachePaths         (modules/host-cache-handle.js)   ← activate/__config 时构建路径 Set
```

## 四、关键 API

### 入口层（main.js）

| 事件/函数 | 说明 |
|-----------|------|
| `fetch` 事件监听 | 拦截同域及 `core.noneos.com` 请求（默认 `core.noneos.com`，可通过 `globalThis.SERVER_OPTIONS.coreHostName` 覆盖），按前缀路由 |
| `/__config` 路径 | 特殊路由：触发 `reloadSystemConfig()` 并返回 `{ serviceWorkerVersion, systemConfig, hostCacheConfig }` JSON；`hostCacheConfig` 来自宿主 sw.js 中的 `globalThis.NONEOS_HOST_CACHE`（未配置时为 `null`） |
| `install` | `skipWaiting()` 立即激活 |
| `activate` | `clients.claim()` 接管页面，1s 后刷新配置 + `initHostCachePaths()` |
| `reloadSystemConfig()` | 从 OPFS `nos-config/system.json` 读取 `systemConfig`，同时调用 `initHostCachePaths()` 刷新宿主缓存路径集合；失败返回 500 状态码 |
| 初始加载 | SW 脚本加载时（文件末尾）也会立即同步触发一次 `reloadSystemConfig()`，不等 activate |

### 路径路由表

> **匹配顺序**：按表中从上到下顺序匹配；`/__config` 最先短路；`/$mount-/` 必须在 `/$/` 之前。

| 路径前缀 | 处理器 | 说明 |
|----------|--------|------|
| `/__config` | (main.js 内联) | 特殊路由，触发配置重载并返回 JSON |
| `/nos-tool/` | `nostool-handle.js` | nos-tool 资源代理；调试模式直接 fetch，否则回退官方源 |
| `/ncomp/` | `cache-handlers.js` | ncomp 公共组件；生产环境 SWR，dev（localhost）网络优先，多源候选 |
| `/nos/` | `nos-handle.js` | nos 核心资源代理；支持 online / local 模式，调试模式直接 fetch |
| `/gh/` | `cache-handlers.js` | GitHub 仓库文件代理，映射到 jsDelivr |
| `/npm/` | `cache-handlers.js` | NPM 包文件代理，映射到 jsDelivr NPM CDN |
| `/\$mount-/` | `mount-handle.js` | 本地挂载目录文件代理；URL 形态 `/$mount-{id}>/{相对路径}`，id 通过正则 `/\$mount\-(.+)>.+/` 提取 |
| `/\$/` | `file-handler.js` | 本地 OPFS 文件代理；命中时返回带正确 `Content-Type` 头的 Response |
| （兜底）已缓存路径 | `host-cache-handle.js` | 宿主项目缓存；GET 请求路径命中内存 `cachedPaths` Set 时，从 OPFS `host-cache/` 读取；否则不拦截 |

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
- `/__config` 请求触发 `reloadSystemConfig()` 并返回当前版本与配置（含 `hostCacheConfig`）；读取失败返回 500。
- `reloadSystemConfig()` 同时调用 `initHostCachePaths()` 刷新宿主缓存路径集合。
- 配置存储在 OPFS `nos-config/system.json` 中，由 `nos-tool/_install/main.js` 的 `updateSystemConfig()` 通过 `nos/fs` 句柄 API 写入（nos-tool 等上层应用通过触发安装流程间接写入）。

### 7. 宿主项目缓存（host-cache-handle.js）

允许使用 NoneOS Core 的宿主项目（如 Mazmot）缓存自己的文件实现离线访问。

**配置方式**：宿主在自己的 `sw.js` 中，`importScripts` **之前**设置全局变量：

```js
globalThis.NONEOS_HOST_CACHE = { manifest: "/host-cache.json" };
importScripts("https://core.noneos.com/sw/dist.js?v=" + version);
```

**工作原理**：
1. `/__config` 响应中携带 `hostCacheConfig`（即 `globalThis.NONEOS_HOST_CACHE`），页面侧通过 `check()` 获取。
2. `install()` 完成后自动调用 `installHostCacheIfConfigured()`，下载清单内所有文件写入 OPFS `host-cache/`。
3. SW activate / `/__config` 时调用 `initHostCachePaths()` 从 OPFS `host-cache/manifest.json` 构建内存路径 `Set`。
4. fetch 链末尾兜底：GET 请求路径命中 `cachedPaths` 时从 OPFS 返回，否则不拦截。

**OPFS 存储结构**：
```
host-cache/
├── manifest.json          ← 清单副本（SW 构建路径 Set 的数据源）
├── apps/main/home.html    ← 按 manifest.files 中的相对路径存储
└── ...
```

**system.json 扩展**：
```json
{
  "hostCache": {
    "version": "1.2.0",
    "cachePath": "host-cache",
    "mode": "local"
  }
}
```

## 六、依赖关系

- `nos/fs/handle/mount/db.js` —— 挂载目录持久化句柄加载
- 浏览器 API：`ServiceWorkerGlobalScope`、`navigator.storage.getDirectory()`、`fetch`、`Response`、`IndexedDB`（被 mount/db.js 用于持久化 FileSystemHandle）

## 七、构建说明

- 源码使用 ES Modules 编写，通过 Rollup 打包为 `sw/dist.js` 与 `sw/dist.min.js`（以及对应的 `.map` sourcemap 文件）。
- 构建命令：`npm run build:sw`；开发模式可使用 `npm run watch:sw`（监听 `sw/src/**` 自动重建）。
- **SW 注册链路**：`nos-tool/_install/main.js`（生产）或 `nos-tool/_install/register.js`（测试/快速）→ `registerSw("sw.js")` → `nos-tool/_install/util.js` 调用 `navigator.serviceWorker.register("/sw.js")` → 根目录 `/sw.js` 执行 `importScripts("/sw/dist.js")`。**注意：实际加载的是未压缩的 `dist.js`，不是 `dist.min.js`**。
- 修改 `sw/src/` 后必须重新构建，否则线上运行的 Service Worker 不会生效。
