# ncomp 公共组件目录上下文

> 本文档供 AI 阅读，用于快速理解 `ncomp` 目录的用途、组件规范及使用方式。

## 一、目录定位

`ncomp`（NoneOS Components）是 NoneOS Core 的公共组件目录，存放与 `nos` 能力直接相关的可复用 UI 组件。基于 `nos` 的上层项目可以通过 `/ncomp/{component}/{component}.html` 路径直接引用这些组件。

## 二、目录结构

```
ncomp/
├── CONTEXT.md                  # 本文档
├── README.md                   # 面向人类的说明文档
├── user-name/
│   ├── user-name.html          # 组件实现
│   └── user-name.sb.html       # sibyl-test 测试用例
└── user-status/
    ├── user-status.html        # 组件实现
    └── user-status.sb.html     # sibyl-test 测试用例
```

## 三、现有组件

### `user-name`

- **路径**：`ncomp/user-name/user-name.html`
- **标签**：`<n-user-name>`
- **依赖**：`/nos/user/main.js`
- **功能**：根据 `user-id` 显示对应用户的用户名。
  - 若本地用户就是自己，直接读取 `user.getInfo().username`。
  - 否则读取本地资料缓存 `user.cred.getProfile(uid)` 中的 `username`。
  - 当设置 `force` 属性时，会尝试主动连接目标用户并刷新资料缓存，再显示最新名称。
  - 资料加载失败（如对端连接尚未就绪）时自动重试最多 3 次（间隔递增 1s/2s）；`userId` 变化后旧的重试轮次自动作废，不会写回过期名称。
  - 失败步骤与原始错误记录在 `el.lastLoadError`（格式 `步骤: message | stack`），供调试与测试诊断。
- **属性**：
  - `user-id`：目标用户 ID。
  - `force`：存在时强制触发在线资料刷新。
  - `namespace`：指定用户命名空间，默认为 `"default"`。
- **回退行为**：资料获取失败时保持显示 `user-id`。

### `user-status`

- **路径**：`ncomp/user-status/user-status.html`
- **标签**：`<n-user-status>`
- **依赖**：`/nos/user/main.js`
- **功能**：根据 `user-id` 显示对应用户的在线/连接状态，以颜色圆点呈现。
  - 默认未查询或查询出错时显示灰色（`--md-sys-color-surface-container`）。
  - 通过服务器查询到对方在线但尚未建立 RTC 直连时，显示 `primary` 色。
  - 任意 session 的 RTC DataChannel 已处于 `open` 状态时，显示 `success` 色。
  - 所有已连接服务器均查找不到对方时，显示 `error` 色。
- **属性**：
  - `user-id`：目标用户 ID。
  - `namespace`：指定用户命名空间，默认为 `"default"`。
- **尺寸**：默认圆点大小为 `8px × 8px`，可通过 `style` 或外部 CSS 覆盖（如 `style="width: 12px; height: 12px;"`）。
- **实时更新**：组件会监听 `remote_user_connected`、`remote_user_disconnected` 和 `rtc_state` 事件，当目标用户状态变化时自动刷新颜色。
- **兜底刷新**：由于对端下线目前无主动推送，组件额外以 30 秒低频轮询刷新在线状态；页面重新可见（`visibilitychange`）时也会立即刷新一次。

## 四、使用方式

在 ofa.js 页面中通过 `l-m` 引用：

```html
<l-m src="/ncomp/user-name/user-name.html"></l-m>
<n-user-name user-id="{targetUserId}"></n-user-name>
```

```html
<l-m src="/ncomp/user-status/user-status.html"></l-m>
<n-user-status user-id="{targetUserId}" style="width: 10px; height: 10px;"></n-user-status>
```

## 五、资源加载与缓存

`/ncomp/` 路由在 `sw/src/main.js` 中注册，实际处理函数是 `sw/src/modules/cache-handlers.js` 中导出的 `handleNcompRequest`（与 `/gh/`、`/npm/` 共用 SWR 工厂）。**注意：项目中不存在 `ncomp-handle.js` 文件**。

- **`localhost:*`（dev 环境，判定条件 `/^localhost:/.test(location.host)`）**：走"网络优先"模式，候选源依次为 `localhost:3002` → 官方源 `core.noneos.com` → 同域兜底；任一源成功后**同步**写入 OPFS `/ncomp/` 缓存并刷新内存级时间戳；全部失败时回退 OPFS 缓存。
- **非本地环境**：采用 SWR（Stale-While-Revalidate）策略，单一候选源为 `https://core.noneos.com/`：
  - 缓存命中且在 5 分钟 TTL 内：直接返回缓存，不发起网络请求。
  - 缓存命中但已过 TTL：**立即返回旧缓存**，后台异步重新拉取并**直接覆盖**写入 OPFS（无 hash 对比）。
  - 缓存未命中：同步请求官方源，成功后写入 OPFS 并返回；失败则返回 500 错误响应。

### TTL 与状态

5 分钟 TTL 仅维护在 Service Worker **进程内存**中（`cache-handlers.js` 模块级 `lastRefreshAt: Map`），SW 重启后即清空，等价于"重启即视为过期"。OPFS 中只保存组件文件本体，**不保存任何元数据**（无 `cachedAt`/`hash` 字段，也无 `/nos-config/ncomp-meta/` 目录）。

因此，组件文件首次请求后会缓存到 OPFS；TTL 过期后会在后台**无条件**拉取最新版本覆盖缓存，以兼顾离线可用与自动更新。

## 六、开发规范

1. 每个组件独占一个子目录，目录名与组件标签名（不含 `n-` 前缀）保持一致。
2. 组件入口文件命名为 `{tag-name}.html`。
3. 建议为每个组件编写同名的 `{tag-name}.sb.html` 测试文件，使用 `sibyl-test` 框架验证。
4. 组件内部引用 `nos` 能力时，使用绝对路径 `/nos/...`，确保在不同项目中路径一致。
5. 新增或修改组件后，若 Service Worker 路由或缓存策略有变化，需同步更新 `sw/CONTEXT.md`。
