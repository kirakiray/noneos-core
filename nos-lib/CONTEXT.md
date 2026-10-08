# nos-lib 官方在线库上下文

> 本文档供 AI 阅读，用于快速理解 `nos-lib` 目录的用途、内容规范、路由与缓存策略。

## 一、目录定位

`nos-lib` 是 NoneOS Core 的**官方在线库**：由官方 CDN（`core.noneos.com`）分发、**不进入 `nos.tgz` 签名包**的公共资源目录。与 `nos/` 的边界：必须随系统安装、参与哈希签名校验的核心能力放 `nos/`；官方在线分发的可复用资源放 `nos-lib/`。

包含两部分：

1. **公共 UI 组件**（原 `ncomp/` 迁入）：`<n-user-name>`、`<n-user-status>`；
2. **安装/版本设施**（原 `nos-tool/_install/` 与 `nos-tool/comps/nos-version.html` 迁入）：`_install/` 引导与 `<nos-version>` 组件。

基于 `nos` 的上层项目可通过 `/nos-lib/{path}` 路径直接引用。

## 二、目录结构

```
nos-lib/
├── CONTEXT.md                  # 本文档
├── README.md                   # 面向人类的说明文档
├── user-name/
│   ├── user-name.html          # 组件实现
│   └── user-name.sb.html       # sibyl-test 测试用例
├── user-status/
│   ├── user-status.html        # 组件实现
│   └── user-status.sb.html     # sibyl-test 测试用例
├── nos-version/
│   └── nos-version.html        # 安装/版本入口组件
└── _install/
    ├── main.js                 # 安装/升级主流程（install/check/installServiceWorker/updateSystemConfig）
    ├── util.js                 # 验签与在线数据（PINNED_ROOT_KEY_HASHES 信任锚、verifyRootCert/verifyRootStatus/getOnlineData/registerSw/clearSw）
    ├── register.js             # 测试环境快速注册 SW
    └── _install-nos.html       # nos-version 手动测试页（未纳入 test-index 编排）
```

## 三、内容说明

### `user-name`（`<n-user-name>`）

- **路径**：`nos-lib/user-name/user-name.html`
- **依赖**：`/nos/user/main.js`
- **功能**：根据 `user-id` 显示对应用户的用户名。
  - 若本地用户就是自己，直接读取 `user.getInfo().username`。
  - 否则读取本地资料缓存 `user.cred.getProfile(uid)` 中的 `username`。
  - 当设置 `force` 属性时，会尝试主动连接目标用户并刷新资料缓存，再显示最新名称。
  - 资料加载失败时自动重试最多 3 次（间隔递增 1s/2s）；`userId` 变化后旧的重试轮次自动作废。
  - 失败步骤与原始错误记录在 `el.lastLoadError`（格式 `步骤: message | stack`）。
- **属性**：`user-id`（目标用户 ID）、`force`（存在时强制刷新）、`namespace`（用户命名空间，默认 `"default"`）。
- **回退行为**：资料获取失败时保持显示 `user-id`。

### `user-status`（`<n-user-status>`）

- **路径**：`nos-lib/user-status/user-status.html`
- **依赖**：`/nos/user/main.js`
- **功能**：根据 `user-id` 显示对应用户的在线/连接状态（颜色圆点）。
  - 默认/出错：灰色（`--md-sys-color-surface-container`）；服务器在线未直连：`primary`；RTC DataChannel `open`：`success`；均不在线：`error`。
  - 监听 `remote_user_connected` / `remote_user_disconnected` / `rtc_state` 事件实时刷新；30 秒低频轮询兜底；`visibilitychange` 时立即刷新。
- **属性**：`user-id`、`namespace`（默认 `"default"`）。
- **尺寸**：默认 `8px × 8px`，可通过 `style` 覆盖。

### `nos-version`（`<nos-version>`）

- **路径**：`nos-lib/nos-version/nos-version.html`
- **依赖**：`../_install/main.js`（相对引用，与 `_install/` 同级故路径稳定）
- **功能**：安装/版本入口组件，UI 状态机为 loading → installed（含 upgradable 按钮）/ installing（进度条）/ 未安装（Install 按钮）。
- **属性**：`auto-install`（存在时检测到未安装或可升级即自动触发安装）。
- **事件**：`installed`（`{version}`）、`upgradable`（`{version, lastVersion}`）、`uninstalled`、`install-start`、`install-progress`（`{step, desc, total}`）、`install-complete`、`check-start`、`error`（`{message, phase: "check"|"install", error}`，`error` 为原始错误对象，供消费方读取 stack / cause）。

### `_install/`（安装/升级引导）

- `main.js`：导出 `install` / `check` / `installServiceWorker` / `installSystemFile` / `updateSystemConfig`。内部以 `../../` 相对引用仓库根的 `nos.tgz`、`nos/` 源码（目录处于顶层，层级恰与迁移前一致）。
  - `check()` 判定：`serviceWorkerVersion` 或 `systemConfig.version` 缺失，或 `systemConfig.mode !== "local"`（`mode:"online"` 是安装过程的过渡态，装到一半被打断会停留在此）→ 返回 `uninstalled` 触发重装自愈；否则版本与线上一致返回 `installed`、不一致返回 `upgradable`。版本比对用 `getOnlineData({ allowCache: true })`：在线配置拉取失败（网络异常/被拦截）时降级用 `nos/storage` 缓存的最近一份在线校验通过的数据（视为已安装、跳过升级判断），全新安装无缓存可降级时抛可读错误；install 流程（`installServiceWorker` / `installSystemFile`）不降级、必须实时在线。
- `util.js`：导出 `verifyRootStatus` / `verifyRootCert` / `getOnlineData` / `registerSw` / `clearSw`；内置 `PINNED_ROOT_KEY_HASHES` 信任锚（由 `scripts/rotate-root.js` 自动重写，路径硬编码于该脚本，移动目录时必须同步）。`getOnlineData({ allowCache = false } = {})`：`allowCache` 为 `true` 时 root-cert.json / nos.json 在线拉取失败降级用 `nos-root-trust` 空间的缓存（`cached-root-cert` / `cached-nos-json`，写入时机 = 每次在线拉取且校验通过后；降级数据不回写），无缓存抛带 cause 的可读错误；默认 `false` 原样抛网络错误。
- `register.js`：测试环境快速注册 SW，测试文件以 `import registration from "/nos-lib/_install/register.js"` 引用。
- 信任链机制详见 [CONTEXT.md「根证书信任集」](../CONTEXT.md#根证书信任集与发布签名链) 与 skill 的 `references/root-cert.md`。

## 四、使用方式

```html
<l-m src="/nos-lib/user-name/user-name.html"></l-m>
<n-user-name user-id="{targetUserId}"></n-user-name>
```

跨域页面加载安装组件使用完整官方地址：

```html
<l-m src="https://core.noneos.com/nos-lib/nos-version/nos-version.html"></l-m>
<nos-version auto-install></nos-version>
```

## 五、路由、缓存与旧前缀兼容

路由注册在 `sw/src/main.js`（根 CONTEXT.md 第二节有汇总表）：

- **`/nos-lib/{path}`** → `handleNosLibRequest`（`sw/src/modules/cache-handlers.js`，SWR 工厂）：
  - **`localhost:*`（dev）**：网络优先，候选源依次为 `localhost:3002` → 官方源 → 同域兜底；成功后同步写 OPFS 缓存。
  - **非本地**：SWR 策略，单一候选源 `https://core.noneos.com/nos-lib/{path}`；5 分钟内存 TTL（SW 进程内 `lastRefreshAt: Map`），过期后台无条件重拉覆盖；OPFS 只存文件本体，无元数据。
  - OPFS 缓存键即 path，落在 `nos-lib/` 目录。
- **`/nos-lib/_install/{path}`** → `handleOfficialSourceRequest`（`sw/src/modules/official-handle.js`）：安装引导必须实时回源，**不读写任何缓存**；`localhost:3002` 直接 fetch，其他 localhost 代理到 3002，生产回源官方。
- **旧前缀别名**（`/ncomp/{path}`、`/nos-tool/_install/{path}`、`/nos-tool/comps/{path}`）：main.js 在分发前把 path 归一化为 `/nos-lib/` 新路径（`comps/nos-version.html` → `nos-version/nos-version.html`），再走上述处理器；跨域直连消费者由托管层 `_redirects` 的 301 规则兜底。

> 历史备注：原 `/ncomp/` 处理器名为 `handleNcompRequest`、原 `/nos-tool/` 处理器为 `nostool-handle.js`（现改名 `official-handle.js` 并与 `_install` 共用）。

## 六、开发规范

1. 每个组件独占一个子目录，目录名与组件标签名保持一致（`n-` 前缀组件去掉 `n-`）。
2. 组件入口文件命名为 `{tag-name}.html`，建议配套同名 `{tag-name}.sb.html` 测试。
3. 组件内部引用 `nos` 能力时，使用绝对路径 `/nos/...`，确保在不同项目中路径一致。
4. 新增资源前，先确认它应该放 `nos/`（进签名包随系统安装）还是 `nos-lib/`（在线分发），不要把应随包安装的内容放进 `nos-lib/`。
5. 移动/重命名本目录内容时，必须同步：`sw/src/main.js` 归一化规则、`scripts/rotate-root.js` 的 `clientUtilPath`、`_redirects` 301 规则、各文档与 skill 引用。
