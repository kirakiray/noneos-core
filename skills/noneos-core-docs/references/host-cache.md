# 宿主项目离线缓存 (host-cache)

NoneOS Core 的 Service Worker 提供了宿主项目离线缓存功能，允许使用 noneos-core 的项目缓存自己的文件列表，实现离线访问。

## 启用方式

在宿主项目的 `sw.js` 中，`importScripts` 之前设置 `globalThis.HOST_CACHE_CONFIG`：

```javascript
globalThis.HOST_CACHE_CONFIG = true;
importScripts("https://core.noneos.com/sw/dist.js");
```

可选配置：
```javascript
globalThis.HOST_CACHE_CONFIG = {
  manifestPath: "/host-cache.json", // 自定义 manifest 路径，默认 /host-cache.json
};
```

## Manifest 文件

在项目根目录创建 `host-cache.json`（或自定义路径）：

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "files": [
    "index.html",
    "main.js",
    "css/style.css",
    "apps/home.html"
  ]
}
```

- `name`：项目名称
- `version`：版本号，版本变化时触发缓存更新
- `files`：需要离线缓存的文件路径列表（相对于根目录，不带前导 `/`）

## 工作原理

### 预缓存

SW 加载时会读取 manifest，将 `files` 列表中的文件逐个下载并写入 OPFS 缓存。版本变化时，先删除不再需要的旧文件，再重新下载所有文件。

### fetch 拦截

当页面请求同域 GET 资源时，如果路径在 manifest 的 files 列表中，SW 会进入 host-cache 处理。行为按环境区分：

**开发环境（localhost / 127.0.0.1）旁路**：`self.location.hostname` 为 `localhost` 或 `127.0.0.1` 时，host-cache 完全不拦截请求，所有请求直接走网络。开发者在本地修改宿主项目文件后无需 bump version，刷新页面即可看到改动生效。

**生产环境 SWR（stale-while-revalidate）**：
- 命中 OPFS 缓存时立即返回缓存内容（保证响应速度）。
- 若距上次后台刷新超过 5 分钟（`SWR_TTL`），SW 会异步 `fetch` 最新文件覆盖 OPFS 缓存（带离线守卫 `navigator.onLine` 与并发去重 `refreshing: Set`）。
- **下次刷新即可拿到新版本**——无需修改 `host-cache.json` 的 version 字段，生产环境也能在 5 分钟内自愈陈旧缓存。
- 缓存未命中时同步回退网络，并将响应写入 OPFS 缓存。

> version 触发的预缓存机制仍然保留，适用于需要立即全量更新的场景（如发版后强制刷新所有文件）。SWR 是对它的补充，解决"version 没同步 bump 时线上拿不到新文件"的问题。

### 版本更新检测

SW 不会自动检测 `host-cache.json` 的变化（浏览器只在 `sw.js` 本身变化时才更新 SW）。需要前端主动检查并触发更新：

```javascript
// 1. 获取当前 SW 缓存的版本
const cached = await fetch("/__host-cache").then(r => r.json());
// cached: { name, version, fileCount, precaching }

// 2. 获取最新 manifest
const latest = await fetch("/host-cache.json", { cache: "no-store" }).then(r => r.json());

// 3. 版本不同时，触发更新
if (cached.version !== latest.version) {
  const result = await fetch("/__update-host-cache").then(r => r.json());
  // result: { ok: true, downloaded: 42, failed: 0, total: 42 }
}
```

> 也可以直接调用 `fetch("/__update-host-cache")` 触发更新，无需先检查版本。SW 会自行拉取最新 manifest 并在版本变化时执行预缓存。

### 进度监听

SW 在预缓存过程中会通过 `postMessage` 广播进度：

```javascript
navigator.serviceWorker.addEventListener("message", (event) => {
  const { type, total, downloaded, failed } = event.data;
  if (type === "host-cache-progress") {
    console.log(`预缓存进度: ${downloaded}/${total} (失败: ${failed})`);
  } else if (type === "host-cache-complete") {
    console.log(`预缓存完成: ${downloaded} 成功, ${failed} 失败`);
  }
});
```

## 状态查询

通过 `/__host-cache` 路由查询当前缓存状态：

```javascript
const status = await fetch("/__host-cache").then(r => r.json());
// { name: "my-app", version: "1.0.0", fileCount: 42, precaching: false }
```

## OPFS 存储结构

```
host-cache/
  manifest.json    # 持久化的 manifest
  files/           # 缓存文件，保持原始路径结构
    index.html
    main.js
    css/style.css
    ...
```

## 注意事项

- manifest 文件本身不走缓存，始终从网络获取，确保前端能检测到版本变化。
- 文件路径不应以 `/nos/`、`/gh/`、`/npm/`、`/ncomp/`、`/nos-tool/`、`/$` 等 noneos-core 保留前缀开头，否则会被对应路由优先处理。
- 预缓存是异步的，不阻塞 SW 的 install/activate。预缓存完成前，未缓存的文件会回退到网络。
- 首次安装时所有文件都需要网络下载，请确保在网络环境下完成首次预缓存。
- **开发环境（localhost / 127.0.0.1）下 host-cache 自动旁路**：修改宿主项目文件后无需 bump version，刷新即可生效。如需在本地测试离线缓存行为，请使用非 localhost 域名（如局域网 IP）访问。
- **生产环境 SWR 的"第二次刷新"特性**：修改宿主项目文件并部署后，首个访问用户首次刷新会拿到旧缓存（同时触发后台刷新），第二次刷新才拿到新版本。如需所有用户立即生效，仍可 bump version 触发预缓存。
