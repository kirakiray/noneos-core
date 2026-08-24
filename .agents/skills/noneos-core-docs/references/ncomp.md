# ncomp 公共组件

`ncomp`（NoneOS Components）是 NoneOS Core 的公共组件目录，存放与 `nos` 核心能力强相关的可复用 UI 组件。基于 `nos` 的上层项目可以通过 `/ncomp/{component}/{component}.html` 路径直接引用。

## 设计原则

- **克制收录**：只存放与 `nos` 核心能力强相关、在多个项目中会被高频复用的组件。
- **可定制性**：组件保持简洁，允许第三方基于它们做较大程度的定制和扩展。
- **命名规范**：组件标签统一使用 `n-` 前缀（如 `n-user-name`），避免与 HTML 原生标签或第三方组件冲突。
- **路径稳定**：组件内部引用 `nos` API 时使用绝对路径 `/nos/...`，确保在不同宿主项目中路径一致。

## 使用方式

```html
<l-m src="https://core.noneos.com/ncomp/user-name/user-name.html"></l-m>
<n-user-name user-id="{userId}"></n-user-name>
```

在本地开发时，也可以使用相对路径或 `/ncomp/...` 路径：

```html
<l-m src="/ncomp/user-name/user-name.html"></l-m>
```

## 组件列表

### `user-name`

根据 `user-id` 显示对应用户的用户名。

- **文件路径**：`/ncomp/user-name/user-name.html`
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
- 资料获取失败时保持显示 `user-id`。

#### 使用示例

```html
<l-m src="/ncomp/user-name/user-name.html"></l-m>
<n-user-name user-id="xxxxxxxxxxxxxxxx"></n-user-name>
```

#### 注意事项

- 组件需要在已初始化 NoneOS Core 用户系统的页面中使用。
- `force` 刷新会尝试建立 P2P 连接，目标用户不在线时连接会失败，但组件仍会从资料缓存中读取。

### `user-status`

根据 `user-id` 显示对应用户的在线/连接状态，以颜色圆点呈现。

- **文件路径**：`/ncomp/user-status/user-status.html`
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
- 组件会监听 `remote_user_connected`、`remote_user_disconnected` 和 `rtc_state` 事件，目标用户状态变化时自动刷新颜色。

#### 使用示例

```html
<l-m src="/ncomp/user-status/user-status.html"></l-m>
<n-user-status user-id="xxxxxxxxxxxxxxxx" style="width: 10px; height: 10px;"></n-user-status>
```

#### 注意事项

- 组件需要在已初始化 NoneOS Core 用户系统的页面中使用。
- 颜色依赖 senti-ui 的语义化 CSS 变量（`--md-sys-color-*`），宿主页面需要引入 senti-ui 颜色体系（`st-boot` 或任一 `st-*` 组件）以保证主题一致性。

## 资源加载与缓存

`/ncomp/` 下的资源由 Service Worker 统一代理（`sw/src/modules/cache-handlers.js` 导出的 `handleNcompRequest`，在 `sw/src/main.js` 中注册路由；项目中不存在 `ncomp-handle.js` 文件）：

- **`localhost:*`（dev 环境）**：走"网络优先"模式，候选源依次为 `localhost:3002` → 官方源 `https://core.noneos.com/` → 同域兜底；任一源成功后**同步**写入 OPFS `/ncomp/` 缓存并刷新内存级时间戳后返回；全部失败时回退 OPFS 缓存。
- **非本地环境**：采用 SWR（Stale-While-Revalidate）策略，单一候选源为 `https://core.noneos.com/`：
  - 缓存命中且在 5 分钟 TTL 内：直接返回缓存，不发起网络请求。
  - 缓存命中但已过 TTL：**立即返回旧缓存**，后台异步重新拉取并**直接覆盖**写入 OPFS（无 hash 对比）。
  - 缓存未命中：同步请求官方源，成功后写入 OPFS 并返回；失败则返回 500 错误响应。

### TTL 与缓存状态

5 分钟 TTL 仅维护在 Service Worker **进程内存**中（模块级 `lastRefreshAt: Map`），SW 重启后即清空，等价于"重启即视为过期"。OPFS 中只保存组件文件本体，**不保存任何元数据**（无 `cachedAt`/`hash` 字段，也不存在 `/nos-config/ncomp-meta/` 目录）。
