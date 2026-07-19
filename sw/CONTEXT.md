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
└── handleFileRequest         (modules/file-handler.js)
    └── getFileHandle         (modules/file-system.js)
```

## 四、关键 API

### 入口层（main.js）

| 事件/函数 | 说明 |
|-----------|------|
| `fetch` 事件监听 | 拦截同域及 `core.noneos.com` 请求，按前缀路由 |
| `install` | `skipWaiting()` 立即激活 |
| `activate` | `clients.claim()` 接管页面，1s 后刷新配置 |
| `reloadSystemConfig()` | 从 OPFS `nos-config/system.json` 读取 `systemConfig` |

### 路径路由表

| 路径前缀 | 处理器 | 说明 |
|----------|--------|------|
| `/nos-tool/` | `nostool-handle.js` | nos-tool 资源代理；调试模式直接 fetch，否则回退官方源 |
| `/ncomp/` | `cache-handlers.js` | ncomp 公共组件；生产环境 SWR，dev（localhost）网络优先，多源候选 |
| `/nos/` | `nos-handle.js` | nos 核心资源代理；支持 online / local 模式，调试模式直接 fetch |
| `/gh/` | `cache-handlers.js` | GitHub 仓库文件代理，映射到 jsDelivr |
| `/npm/` | `cache-handlers.js` | NPM 包文件代理，映射到 jsDelivr NPM CDN |
| `/\$mount-/` | `mount-handle.js` | 本地挂载目录文件代理 |
| `/\$/` | `file-handler.js` | 本地 OPFS 文件代理 |

### 通用工具

| 函数 | 文件 | 说明 |
|------|------|------|
| `getRootDirectory()` | `file-system.js` | 缓存并返回 `navigator.storage.getDirectory()` |
| `getFileHandle({ path, create })` | `file-system.js` | 按 `/` 分割路径，逐级定位 OPFS 文件句柄 |
| `getContentType(path)` | `mime-types.js` | 根据扩展名返回 MIME Type |

## 五、关键实现细节

### 1. `/nos/` 资源代理策略（nos-handle.js）

- **`systemConfig.mode === "online"` 或未配置**：直接 `fetch(request)` 请求线上资源。
- **`systemConfig.mode === "local"`**：将 `/nos/` 替换为 `systemConfig.nosMapPath + "/"`，优先从 OPFS 读取；若文件不存在或为空，回退 `fetch(request)`。
- **`localhost:3002` 调试模式**：不读取 `systemConfig`，直接 `fetch(request)`，避免加载 OPFS 中的旧缓存。
- **其他 `localhost:*` 调试模式**（例如页面在 `localhost:3003` 但通过 `importScripts("http://localhost:3002/sw/dist.js")` 加载本 SW）：优先将 `/nos/` 请求 URL 的端口替换为 `3002`，代理到 `localhost:3002` 的在线资源；若 `localhost:3002` 未启动，则继续走默认的 online/local 处理路线。

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

- `systemConfig` 初始为空对象，激活后 1s 自动加载。
- `/__config` 请求触发 `reloadSystemConfig()` 并返回当前版本与配置。
- 配置存储在 OPFS `nos-config/system.json` 中，由上层（如 nos-tool）写入。

## 六、依赖关系

- `nos/fs/handle/mount/db.js` —— 挂载目录持久化句柄加载
- 浏览器 API：`ServiceWorkerGlobalScope`、`navigator.storage.getDirectory()`、`fetch`、`Response`

## 七、构建说明

- 源码使用 ES Modules 编写，通过 Rollup 打包为 `sw/dist.js` 与 `sw/dist.min.js`。
- 构建命令：`npm run build:sw`。
- `index.html` 注册的是构建产物 `sw/dist.min.js`。
- 修改 `sw/src/` 后必须重新构建，否则线上运行的 Service Worker 不会生效。
