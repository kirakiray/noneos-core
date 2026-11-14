# nos-lib 官方在线库

`nos-lib` 是 NoneOS Core 的**官方在线库**：由官方 CDN（`core.noneos.com`）分发、不进入 `nos.tgz` 签名包的公共资源目录。基于 `nos` 的上层项目可以通过 `/nos-lib/{path}` 路径直接引用。包含公共 UI 组件（`<n-user-name>`、`<n-user-status>`、`<n-icon>`、`<locale-text>`）、i18n 运行时（`getLocaleText`）、安装/版本入口组件（`<nos-version>`）与安装引导 `_install/`。

## 设计原则

- **与 `nos/` 的边界**：必须随系统安装、参与哈希签名校验的核心能力放 `nos/`；官方在线分发的可复用资源放 `nos-lib/`。
- **克制收录**：只存放与 `nos` 核心能力强相关、在多个项目中会被高频复用的资源。
- **可定制性**：组件保持简洁，允许第三方基于它们做较大程度的定制和扩展。
- **命名规范**：nos 能力相关组件标签统一使用 `n-` 前缀（如 `n-user-name`）；`nos-version` 为历史沿用例外。
- **路径稳定**：组件内部引用 `nos` API 时使用绝对路径 `/nos/...`，确保在不同宿主项目中路径一致。

## 使用方式

```html
<l-m src="https://core.noneos.com/nos-lib/user-name/user-name.html"></l-m>
<n-user-name user-id="{userId}"></n-user-name>
```

在 NoneOS 宿主页面中，也可以使用相对路径或 `/nos-lib/...` 路径：

```html
<l-m src="/nos-lib/user-name/user-name.html"></l-m>
```

## 公共组件列表

### `user-name`

根据 `user-id` 显示对应用户的用户名。

- **文件路径**：`/nos-lib/user-name/user-name.html`
- **标签**：`<n-user-name>`
- **依赖**：`/nos/user/main.js`

#### 属性

| 属性名 | 默认值 | 说明 |
|--------|--------|------|
| `user-id` | `""` | 目标用户的 userId |
| `force` | `null` | 设置时强制触发在线资料刷新 |
| `namespace` | `"default"` | 用户命名空间 |

#### 功能说明

- 若目标用户就是当前本地用户，直接读取 `user.getInfo().username`。
- 否则读取本地资料缓存 `user.cred.getProfile(uid)` 中的 `username`。
- 设置 `force` 属性时，会尝试主动连接目标用户并刷新资料缓存，再显示最新名称。
- 资料加载失败时自动重试最多 3 次（间隔递增 1s/2s）；失败时保持显示 `user-id`。

#### 使用示例

```html
<l-m src="/nos-lib/user-name/user-name.html"></l-m>
<n-user-name user-id="xxxxxxxxxxxxxxxx"></n-user-name>
```

#### 注意事项

- 组件需要在已初始化 NoneOS Core 用户系统的页面中使用。
- `force` 刷新会尝试建立 P2P 连接，目标用户不在线时连接会失败，但组件仍会从资料缓存中读取。

### `user-status`

根据 `user-id` 显示对应用户的在线/连接状态，以颜色圆点呈现。

- **文件路径**：`/nos-lib/user-status/user-status.html`
- **标签**：`<n-user-status>`
- **依赖**：`/nos/user/main.js`

#### 属性

| 属性名 | 默认值 | 说明 |
|--------|--------|------|
| `user-id` | `""` | 目标用户的 userId |
| `namespace` | `"default"` | 用户命名空间 |

#### 尺寸

默认圆点大小为 `8px × 8px`，可通过 `style` 或外部 CSS 覆盖：

```html
<n-user-status user-id="xxxxxxxxxxxxxxxx" style="width: 12px; height: 12px;"></n-user-status>
```

#### 功能说明

- 默认未查询或查询出错时显示灰色（`--md-sys-color-surface-container`）。
- 通过服务器查询到对方在线但尚未建立 RTC 直连时，显示 `primary` 色。
- 任意 session 的 RTC DataChannel 已处于 `open` 状态时，显示 `success` 色。
- 所有已连接服务器均查找不到对方时，显示 `error` 色。
- 组件会监听 `remote_user_connected`、`remote_user_disconnected` 和 `rtc_state` 事件，目标用户状态变化时自动刷新颜色；另有 30 秒低频轮询兜底。

#### 使用示例

```html
<l-m src="/nos-lib/user-status/user-status.html"></l-m>
<n-user-status user-id="xxxxxxxxxxxxxxxx" style="width: 10px; height: 10px;"></n-user-status>
```

#### 注意事项

- 组件需要在已初始化 NoneOS Core 用户系统的页面中使用。
- 颜色依赖 senti-ui 的语义化 CSS 变量（`--md-sys-color-*`），宿主页面需要引入 senti-ui 颜色体系（`st-boot` 或任一 `st-*` 组件）以保证主题一致性。

### `locale-text`

`/nos-lib/locale-text/locale-text.html` 提供 `<locale-text>` 组件，`/nos-lib/locale-text/get-locale-text.js` 提供 `getLocaleText()` 运行时。详见 [locale-text 文档](locale-text.md)。

### `n-icon`

`/nos-lib/n-icon/n-icon.html` 提供 `<n-icon>` 图标组件（基于 `nos/storage` 持久化缓存）。详见 [n-icon 文档](n-icon.md)。

### `nos-version` 与 `_install/`

安装/版本设施同属本目录：`/nos-lib/nos-version/nos-version.html` 为安装入口组件，`/nos-lib/_install/` 为其引导（SW 注册、版本检查、完整安装、根证书信任链校验）。详见 [nos-version 组件文档](nos-version.md) 与 [根证书信任集](root-cert.md)。

## 资源加载与缓存

`/nos-lib/` 下的资源由 Service Worker 统一代理（`sw/src/modules/cache-handlers.js` 导出的 `handleNosLibRequest`，在 `sw/src/main.js` 中注册路由；安装引导 `/nos-lib/_install/` 则由 `official-handle.js` 实时回源、不缓存）：

- **`localhost:*`（dev 环境）**：走"网络优先"模式，候选源依次为 `localhost:3002` → 官方源 `https://core.noneos.com/nos-lib/...` → 同域兜底；任一源成功后**同步**写入 OPFS `nos-lib/` 缓存并刷新内存级时间戳后返回；全部失败时回退 OPFS 缓存。
- **非本地环境**：采用 SWR（Stale-While-Revalidate）策略，单一候选源为 `https://core.noneos.com/nos-lib/{path}`：
  - 缓存命中且在 5 分钟 TTL 内：直接返回缓存，不发起网络请求。
  - 缓存命中但已过 TTL：**立即返回旧缓存**，后台异步重新拉取，校验通过后才覆盖写入 OPFS；校验失败保留旧缓存。
  - 缓存未命中：同步请求官方源，**按 `nos-lib/nos-lib.json` 验签 + 验文件 hash**，通过后才写入 OPFS 并返回；失败则返回 500 错误响应。

### TTL 与缓存状态

5 分钟 TTL 仅维护在 Service Worker **进程内存**中（模块级 `lastRefreshAt: Map`），SW 重启后即清空，等价于"重启即视为过期"。OPFS 中保存组件文件本体与已验签的清单（`nos-lib/.manifest.json`），不保存 TTL/`cachedAt` 等元数据。

### 签名校验（生产环境）

- 清单：`nos-lib/nos-lib.json`（`{ version, publicKey, signTime, hashes, signature }`，整文件 SHA-256），由 `scripts/sign-noslib-hashes.js` 用根证书 active 密钥签发。
- SW 构建期把根证书中未退役公钥注入 `sw/src/modules/noslib-verify.js` 作为 pin。
- 首次加载 nos-lib 资源时拉取清单（`no-store`）→ pin 校验 → `verifyData` 验签 → hash 比对 → 落盘；缓存命中不重复校验。
- `version` 单调递增，低于缓存版本时拒绝回滚；版本升高时清空 `nos-lib/` OPFS 缓存。
- `localhost` / `127.0.0.1` / `[::1]` 跳过校验；SW 激活前的 `nos-version` / `_install` / 入口页 `locale-text` 不覆盖，仍只依赖 HTTPS。

## 旧前缀兼容

历史前缀仍可访问，但新代码应一律使用 `/nos-lib/`：

- `/ncomp/{path}` → 归一化为 `/nos-lib/{path}`（SW 内）或 301（托管层 `_redirects`）；
- `/nos-tool/_install/{path}` → `/nos-lib/_install/{path}`；
- `/nos-tool/comps/nos-version.html` → `/nos-lib/nos-version/nos-version.html`；
- `/nos/locale-text/{path}`、`/nos/n-icon/{path}` → `/nos-lib/{path}`。
