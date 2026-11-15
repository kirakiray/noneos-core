# nos-lib 官方在线库上下文

> 本文档供 AI 阅读，用于快速理解 `nos-lib` 目录的用途、内容规范、路由与缓存策略。

## 一、目录定位

`nos-lib` 是 NoneOS Core 的**官方在线库**：由官方 CDN（`core.noneos.com`）分发、**不进入 `nos.tgz` 签名包**的公共资源目录。与 `nos/` 的边界：必须随系统安装、参与哈希签名校验的核心能力放 `nos/`；官方在线分发的可复用资源放 `nos-lib/`。

包含两部分：

1. **安装/版本设施**：`_install/` 引导与 `<nos-version>` 组件；
2. **通用 UI 基础设施**：`<locale-text>` 组件与 `getLocaleText()` 运行时、`<n-icon>` 图标组件。

基于 `nos` 的上层项目可通过 `/nos-lib/{path}` 路径直接引用。

## 二、目录结构

```
nos-lib/
├── CONTEXT.md                  # 本文档
├── README.md                   # 面向人类的说明文档
├── nos-lib.json                # 签名文件清单（构建产物，SW 校验用）
├── locale-text/
│   ├── locale-text.html        # <locale-text> 组件
│   ├── get-locale-text.js      # getLocaleText / getLang / setLang 运行时
│   └── README.md               # 使用说明
├── n-icon/
│   └── n-icon.html             # <n-icon> 图标组件
├── nos-version/
│   └── nos-version.html        # 安装/版本入口组件
└── _install/
    ├── main.js                 # 安装/升级主流程（install/check/installServiceWorker/updateSystemConfig）
    ├── util.js                 # 验签与在线数据（PINNED_ROOT_KEY_HASHES 信任锚、verifyRootCert/verifyRootStatus/getOnlineData/registerSw/clearSw）
    ├── register.js             # 测试环境快速注册 SW
    └── _install-nos.html       # nos-version 手动测试页（未纳入 test-index 编排）
```

## 三、内容说明

### `locale-text/`（`<locale-text>` + `getLocaleText`）

轻量 i18n：`<locale-text>` 组件按 `lang` 声明多语文案，`getLocaleText()` 供脚本使用；语言判定与站点根目录 `/locale-text.json` 回退逻辑都在 `get-locale-text.js`。书写规范与 API 见 [locale-text/README.md](locale-text/README.md)。

### `n-icon/`（`<n-icon>`）

图标组件：按 `icon` 属性（Iconify 名称）拉取 SVG，并基于 `nos/storage` 的 `n-icon` 空间做持久化缓存，避免重复网络请求。

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
<l-m src="/nos-lib/n-icon/n-icon.html"></l-m>
<n-icon icon="mdi:home"></n-icon>
```

跨域页面加载安装组件使用完整官方地址：

```html
<l-m src="https://core.noneos.com/nos-lib/nos-version/nos-version.html"></l-m>
<nos-version auto-install></nos-version>
```

## 五、路由与缓存

路由注册在 `sw/src/main.js`（根 CONTEXT.md 第二节有汇总表）：

- **`/nos-lib/{path}`** → `handleNosLibRequest`（`sw/src/modules/cache-handlers.js`，SWR 工厂）：
  - **`localhost:*`（dev）**：网络优先，候选源依次为 `localhost:3002` → 官方源 → 同域兜底；成功后同步写 OPFS 缓存。
  - **非本地**：SWR 策略，单一候选源 `https://core.noneos.com/nos-lib/{path}`；5 分钟内存 TTL（SW 进程内 `lastRefreshAt: Map`），过期后重新拉取、校验通过才覆盖；OPFS 存文件本体与已验签清单（`nos-lib/.manifest.json`）。
  - OPFS 缓存键即 path，落在 `nos-lib/` 目录。
  - **签名校验**（`sw/src/modules/noslib-verify.js`）：缓存未命中时拉取 `nos-lib/nos-lib.json`（`no-store`）→ pin 校验签名者 → 验签 → 文件 hash 比对，通过后才写 OPFS；缓存命中直接返回。清单 `version` 防回滚，版本升高时清空 `nos-lib/` 缓存；localhost / 127.0.0.1 / [::1] 跳过校验。清单不收录 `*.md` 与 `*.sb.html`。
- **`/nos-lib/_install/{path}`** → `handleOfficialSourceRequest`（`sw/src/modules/official-handle.js`）：安装引导必须实时回源，**不读写任何缓存**；`localhost:3002` 直接 fetch，其他 localhost 代理到 3002，生产回源官方。生产环境同样按 `nos-lib.json` 验签，失败返回 502。

## 六、开发规范

1. 每个组件独占一个子目录，目录名与组件标签名保持一致（`n-` 前缀组件去掉 `n-`）。
2. 组件入口文件命名为 `{tag-name}.html`，建议配套同名 `{tag-name}.sb.html` 测试。
3. 组件内部引用 `nos` 能力时：需要在 SW 接管前也能通过完整 CDN URL 直接加载的组件，使用相对路径 `../../nos/...`；只在 SW 宿主内运行的组件可用绝对路径 `/nos/...`，保持在不同项目中路径一致。
4. 新增资源前，先确认它应该放 `nos/`（进签名包随系统安装）还是 `nos-lib/`（在线分发），不要把应随包安装的内容放进 `nos-lib/`。
5. 移动/重命名本目录内容时，必须同步：`sw/src/main.js` 路由、`scripts/rotate-root.js` 的 `clientUtilPath`、各文档与 skill 引用。
6. 修改本目录任何文件后必须重跑 `npm run build:hashes`（重新签发 `nos-lib/nos-lib.json`），否则 SW 校验会失败；只跑 `build:sw` 不会更新清单。
