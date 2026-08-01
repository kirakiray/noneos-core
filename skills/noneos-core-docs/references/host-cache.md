# 宿主项目缓存 (Host Cache)

NoneOS Core 允许基于它开发的宿主项目（二次操作系统、Web 应用等）缓存自己的文件，实现离线访问。该功能通过 **manifest 清单文件** 驱动，安装时预缓存到 OPFS，Service Worker 在请求时优先从本地返回。

> 宿主项目指通过 `importScripts("https://core.noneos.com/sw/dist.js")` 引用 NoneOS Core 的项目。

---

## 快速开始

### 1. 编写清单文件

在宿主项目根目录创建 `host-cache.json`：

```json
{
  "name": "mazmot",
  "version": "1.0.0",
  "files": [
    "index.html",
    "apps/main/home.html",
    "comps/ercode/ercode.html"
  ]
}
```

### 2. 在 sw.js 中声明

在 `importScripts` **之前**设置全局变量，指向清单文件的 URL：

```js
globalThis.NONEOS_HOST_CACHE = { manifest: "/host-cache.json" };
importScripts("https://core.noneos.com/sw/dist.js?v=" + version);
```

完成。终端用户安装/升级 NoneOS Core 时，清单内的文件会被自动下载并缓存，后续离线也能正常访问。

---

## 清单文件格式 (host-cache.json)

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | 否 | 项目名称，仅用于标识 |
| `version` | string | 是 | 缓存版本号。**修改此值即触发升级**——系统检测到与本地版本不一致时自动重新下载所有文件 |
| `files` | string[] | 是 | 需要缓存的文件路径列表，使用相对根目录的路径（不带开头的 `/`） |

### files 路径规则

- 路径相对于宿主项目根目录，不带开头的 `/`
- 示例：`"apps/main/home.html"` 对应请求路径 `/apps/main/home.html`
- 目录路径（如 `/apps/main/`）会自动补全为 `index.html`，因此若需缓存目录入口，请将 `apps/main/index.html` 写入列表

### 示例

```json
{
  "name": "mazmot",
  "version": "1.2.0",
  "files": [
    "index.html",
    "apps/main/home.html",
    "apps/main/index.html",
    "comps/ercode/ercode.html",
    "comps/ercode/ercode.js"
  ]
}
```

---

## 工作原理

### 安装时预缓存

当用户安装或升级 NoneOS Core 时，`install()` 流程会在系统文件安装完成后自动执行：

1. 拉取 `host-cache.json` 清单
2. 逐个下载 `files` 列表中的文件，写入 OPFS `host-cache/` 目录
3. 最后写入 `host-cache/manifest.json` 副本（供 Service Worker 构建拦截路径集合）
4. 更新 `system.json` 中的 `hostCache` 字段

下载进度会通过 nos-version 组件的安装遮罩统一展示。

### 请求时拦截

Service Worker 在 fetch 路由链**末端**检查请求路径是否命中 `host-cache/manifest.json` 的文件列表：

- **命中** → 优先从 OPFS 返回（离线可用）
- **OPFS 未命中** → 回退到网络请求（与 `/nos/` 路径行为一致）

> `manifest.json` 在所有文件下载完成后才写入，因此安装未完成时 Service Worker 不会拦截，避免返回不完整的缓存。

### OPFS 存储结构

```
host-cache/
├── manifest.json          # 清单副本（SW 读取此文件构建拦截路径集合）
├── index.html
├── apps/
│   └── main/
│       └── home.html
└── comps/
    └── ercode/
        └── ercode.html
```

### system.json 新增字段

安装完成后，`system.json` 中会记录宿主缓存状态：

```json
{
  "hostCache": {
    "version": "1.2.0",
    "cachePath": "host-cache",
    "mode": "local"
  }
}
```

---

## 版本升级

只需修改 `host-cache.json` 中的 `version` 字段并重新部署。系统会在版本检测时（`check()`）发现线上 manifest 的 `version` 与本地 `system.json` 中的 `hostCache.version` 不一致，自动触发升级流程，重新下载所有文件。

### 智能跳过

当**仅宿主缓存**需要升级（NoneOS Core 本身已是最新）时，`install()` 会跳过 NoneOS Core 的重装，仅执行宿主缓存下载，避免不必要的开销。

### 与 nos-version 组件的联动

版本检测与升级通过 `<nos-version>` 组件驱动。当检测到宿主缓存可升级时，组件触发 `upgradable` 事件，`detail` 中包含区分字段：

| 字段 | 类型 | 说明 |
|------|------|------|
| `version` | string | 当前已安装的 NoneOS Core 版本号 |
| `lastVersion` | string | 目标版本号（宿主缓存升级时为 manifest 的 version） |
| `hostCacheUpgradeOnly` | boolean | `true` 表示仅宿主缓存需要升级 |
| `hostCacheOnlineVersion` | string | 宿主缓存的线上最新版本号 |

监听示例：

```html
<nos-version id="nv" auto-install></nos-version>
<script>
  $("#nv").on("upgradable", (e) => {
    const { version, lastVersion, hostCacheUpgradeOnly } = e.detail;
    if (hostCacheUpgradeOnly) {
      console.log("宿主缓存可升级到:", lastVersion);
    } else {
      console.log("NoneOS 可升级:", version, "→", lastVersion);
    }
  });
</script>
```

更多组件细节参考：[nos-version 组件文档](nos-version.md)

---

## 未配置时的行为

如果宿主未设置 `NONEOS_HOST_CACHE`，所有 host-cache 逻辑透明跳过：

- `check()` 不会检测宿主缓存版本
- `install()` 不会下载额外文件
- Service Worker 不会拦截额外路径

不会产生任何报错，功能完全可选。

---

## 配置参考

`globalThis.NONEOS_HOST_CACHE` 接受一个对象：

| 属性 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `manifest` | string | 是 | 清单文件的 URL 路径，如 `/host-cache.json` |

```js
// 标准用法
globalThis.NONEOS_HOST_CACHE = { manifest: "/host-cache.json" };
```
