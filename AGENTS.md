# AI 代理开发指南 (AGENTS.md)

本文件为参与此项目开发的 AI 代理提供核心技术栈上下文和开发规范。在开始任何开发任务前，请务必遵循以下准则。

## 核心技术架构

- **底层架构 (Base Layer)**：基于 `noneos-core` 开发。
  - 涉及文件系统、用户管理及服务通信时，请参考 `noneos-core-docs` 知识库，它的地址在 skills/noneos-core-docs/SKILL.md。
- **应用框架 (Application Layer)**：基于 `ofa.js` 开发。
  - 进行组件开发、路由配置或状态管理时，请参考 `ofajs-docs` 知识库。

## 项目结构与运行时路径映射

> ⚠️ **关键概念**：仓库源码路径 ≠ 浏览器运行时 URL。本项目的 Service Worker 会将一组"虚拟 URL 前缀"映射到不同的后端（本地 OPFS / CDN / 官方源 / 远端用户）。**在仓库中查找文件时，永远以仓库目录结构为准，不要把运行时 URL 当作源码路径去搜索。**

### 源码目录（仓库内真实存在的文件）

| 目录 | 角色 |
|------|------|
| `nos/` | 核心能力层（fs/user/publish/crypto/ai/hybrid-data/util 等） |
| `ncomp/` | 基于 nos 的公共 UI 组件（`<n-user-name>` / `<n-user-status>` 等） |
| `sw/` | Service Worker 源码（`sw/src/`，构建产物 `sw/dist.js`、`sw/dist.min.js`） |
| `server/rust/` | Rust 服务端（WebSocket 握手/中继服务） |
| `server/client/` | 服务端管理前端（admin 页面） |
| `nos-tool/` | 开发工具集（编辑器、studio、file-explore） |
| `docs/` | 多语言文档源（cn/en/ja）与构建产物 |
| `skills/` | Skill 知识库（`noneos-core-docs` 等） |
| `_install/` | 安装/升级入口（生产环境注册 SW、写入 OPFS 系统文件） |
| `tests/` | sibyl-test 测试用例 |
| `scripts/` | 构建/打包/测试脚本 |

### 运行时虚拟路径（由 Service Worker 在运行时映射，**仓库内不存在**）

| URL 前缀 | 实际映射目标 | 处理器（sw/src/modules/） |
|----------|------------|---------------------------|
| `/packages/...` | `nos/` 下的对应模块（如 `/packages/user/main.js` → `nos/user/main.js`） | nos-handle.js |
| `/nos/...` | 按 `systemConfig.mode` 映射到线上 `core.noneos.com` 或本地 OPFS `nos-{version}/` | nos-handle.js |
| `/gh/{path}` | `https://cdn.jsdelivr.net/gh/{path}` | cache-handlers.js |
| `/npm/{path}` | `https://cdn.jsdelivr.net/npm/{path}` | cache-handlers.js |
| `/ncomp/{path}` | 生产：`https://core.noneos.com/ncomp/{path}`；dev：localhost:3002 优先 | cache-handlers.js |
| `/nos-tool/{path}` | 生产：`https://core.noneos.com/nos-tool/{path}`；dev：localhost:3002 优先 | nostool-handle.js |
| `/$mount-{id}>/{path}` | 本地挂载目录（IndexedDB 中持久化的 FileSystemHandle） | mount-handle.js |
| `/$/{path}` | 本地 OPFS 系统目录文件 | file-handler.js |
| `/__config` | 特殊路由：触发 SW 重载 `nos-config/system.json` 并返回版本信息 | main.js 内联 |

**举例**：`nos/fs/main.js` 中动态 `import("./fs-remote/main.js")` —— 这里的 `./fs-remote/main.js` 是运行时通过 SW 加载的远端 FS 模块，**本仓库内未提供源码**，请不要在仓库中搜索它。

### 根目录运行时文件（部署/入口产物，**非源码**）

| 文件 | 角色 | 是否需手动修改 |
|------|------|---------------|
| `/index.html` | 项目入口 HTML | 是（页面初始化逻辑） |
| `/sw.js` | SW 注册桥接文件，**内容仅一行** `importScripts("/sw/dist.js")` | 否（不要改成 dist.min.js） |
| `/nos.json` | 在线版本与哈希清单（构建产物，由 `scripts/pack-nos.js` 生成） | 否（构建生成） |
| `/nos.zip` | 系统文件压缩包（构建产物） | 否（构建生成） |
| `/404.html`、`/_redirects` | Cloud Pages 托管配置 | 视部署需求 |

## UI 与视觉规范

- **组件库**：项目深度集成 `punch-ui` 组件库。
- **视觉系统**：严格遵循 `punch-ui` 的颜色方案与设计语言。
- **开发参考**：在实现 UI 相关功能前，请查阅 `punch-ui` 知识库以保持风格一致性。

## 开发与构建命令

### 开发环境（dev）

启动完整 dev 联调环境（需 3 个终端并行）：

| 命令 | 作用 | 监听地址 |
|------|------|---------|
| `npm run static` | 启动静态文件服务器（页面 + SW 源） | `http://localhost:3002` |
| `npm run ws1` | 启动主 WebSocket 服务（Rust） | `ws://localhost:8081` |
| `npm run ws2` | 启动备 WebSocket 服务（Rust，用于多服务器选路联调） | `ws://localhost:8082` |
| `npm run watch:sw` | 监听 `sw/src/**` 自动重建 SW（可与 static 合并成 `npm run dev`） | — |

便捷组合：
- `npm run dev` = `npm run static` + `npm run watch:sw`（不含 ws，需另起）
- `npm run ws` = `npm run ws1` + `npm run ws2`
- `npm run static2` = 额外的静态服务器（`localhost:30028`，用于多区域测试）

**Rust 服务配置文件**：`server/rust/test-space/config.example.toml`（ws1）与 `config2.toml`（ws2），测试环境已关闭内存过载保护、放宽 session/relay 限制。

### 构建

| 命令 | 作用 |
|------|------|
| `npm run build` | 完整构建 = `build:hashes` + `pack-nos.js` + `build:sw` + `build:skill` |
| `npm run build:sw` | 通过 Rollup 构建 SW（产出 `sw/dist.js` + `sw/dist.min.js`） |
| `npm run build:hashes` | 计算并签名 `nos/` 源码哈希（产出会被 `nos.json` 消费） |
| `npm run build:skill` | 构建 `skills/noneos-core-docs` 知识库（生成 `noneos-core-docs.zip`） |
| `npm run bump` | 升级版本号 = `bump.js` + `npm i` + `npm run build` |

> **重要**：修改 `sw/src/` 下任何文件后必须重新运行 `npm run build:sw`（或开发期使用 `npm run watch:sw`），否则线上 SW 不会生效。

## 开发指令

1. **先读 Skill**：在编写代码或提供建议前，必须先检索并阅读上述对应的 Skill 文档。
2. **遵循模式**：优先采用框架推荐的最佳实践，确保与现有代码库的风格一致。
3. **架构对齐**：所有改动需符合 `noneos-core` 与 `ofa.js` 的设计哲学。
4. **善用 CONTEXT**：各核心模块均提供 `CONTEXT.md` 供 AI 快速理解架构与实现，无需逐文件阅读源码。
   
   **已有 CONTEXT.md 的模块**（修改这些模块时务必先读对应 CONTEXT.md，并按第 5 条同步）：
   - [nos/fs/CONTEXT.md](nos/fs/CONTEXT.md) - 文件系统（OPFS 虚拟 FS、挂载、跨标签页同步）
   - [nos/user/CONTEXT.md](nos/user/CONTEXT.md) - 用户身份与通信（ECDSA 握手、中继、WebRTC、E2EE）
   - [server/rust/CONTEXT.md](server/rust/CONTEXT.md) - 服务端实现（WebSocket、会话管理、流量统计、redb）
   - [nos/publish/CONTEXT.md](nos/publish/CONTEXT.md) - 数据/应用发布（内容寻址、分块、签名清单）
   - [sw/CONTEXT.md](sw/CONTEXT.md) - Service Worker（请求拦截、资源代理、缓存策略）
   - [ncomp/CONTEXT.md](ncomp/CONTEXT.md) - ncomp 公共组件目录（可复用的 nos 相关 UI 组件）
   
   **暂无 CONTEXT.md 的模块**（修改时需逐文件阅读源码，建议在重大改动后补充 CONTEXT.md）：
   - `nos/crypto/`（5 个加密模块：AES/ECDH/ECDSA/RSA/verify）
   - `nos/ai/`（AI 会话与并发控制）
   - `nos/hybrid-data/`（混合数据，远端 + 本地）
   - `nos/util/`（hash/zip/async-pool 等工具）
   - `nos-tool/`（开发工具集：编辑器、studio、file-explore）
   - `server/client/`（服务端管理前端 admin 页面）
5. **同步 CONTEXT**：若上述模块发生代码改动，**必须同步更新对应模块的 `CONTEXT.md`**，保持文档与源码一致。
   - **强制同步触发条件**（必须改 CONTEXT.md）：
     - 公共 API 签名变化（函数名、参数、返回值）
     - IndexedDB schema 变化（库名、版本、仓库、索引、keyPath）
     - 消息协议字段变化（type、action、二进制帧格式）
     - 配置默认值变化（CONFIG 表、默认参数）
     - 文件结构变化（新增/删除/重命名源码文件）
     - 路径前缀路由规则变化（SW 新增/修改路由）
   - **建议同步触发条件**（视改动影响补充）：
     - 关键私有方法/内部实现细节
     - 浏览器兼容性表格
     - 事件清单、错误码、状态机
     - 已知限制 / 已知 bug
   - **审查时机**：若发现 CONTEXT.md 与源码不一致（即使非本次改动），应按第 8 条补充完善。
6. **同步 Skill 文档**：对外可见行为发生变化后，**必须同步更新 `skills/noneos-core-docs/references/` 下对应的参考文档**，确保 Skill 知识库与源码保持一致。触发条件包括：
   - `nos/` 下模块的导出方法、参数、行为语义变化
   - `ncomp/` 新增/删除/修改公共组件（标签名、属性、事件）
   - `sw/` 路由策略或路径前缀变化
   - `server/rust/` admin 命令、消息协议字段、配置项变化
   - CONTEXT.md 中标注为"关键 API"的任何改动
7. **禁止使用 file 协议路径**：文档、注释、配置中的文件引用统一使用相对路径或仓库内可解析的路径（如 `AGENTS.md`、`apps/main/home.html`），禁止使用 `file://` 等本地绝对路径，避免在不同机器上失效。
8. **补充上下文**：若发现 `CONTEXT.md` 中存在信息缺失，应及时补充完善。
9. **AI 常见误判清单**（基于历史踩坑总结，遇到这些情况请额外警惕）：
   - ❌ 把运行时虚拟 URL（`/packages/...`、`/nos/...`、`/gh/...`、`/npm/...`）当作仓库源码路径去查找 → ✅ 应对照"项目结构与运行时路径映射"表，把它们映射回真实源码路径
   - ❌ 在 `nos/fs/` 目录下找 `fs-remote/main.js` → ✅ 这是运行时通过 SW 加载的远端 FS 模块，本仓库不提供源码
   - ❌ 以为 `index.html` 注册了 Service Worker → ✅ 实际是 `_install/main.js`（生产）或 `_install/register.js`（测试）通过 `registerSw("sw.js")` 注册
   - ❌ 以为线上加载的是 `sw/dist.min.js` → ✅ 实际加载的是 `sw/dist.js`（`/sw.js` 内执行 `importScripts("/sw/dist.js")`）
   - ❌ 修改 `sw/src/` 后忘记重建 → ✅ 必须运行 `npm run build:sw` 或开发期使用 `npm run watch:sw`
   - ❌ 把 `nos.json` / `nos.zip` 当源码改 → ✅ 它们是构建产物
   - ❌ 用 `await extendDirHandle(...)` → ✅ `extendDirHandle` / `extendFileHandle` 虽然声明为 `async`，但内部无异步操作，调用处也未 await


## 测试规范

- **客户端测试框架**：项目使用 `sibyl-test` 作为客户端测试框架，测试用例以 `.sb.html` 文件形式编写，位于 `tests/` 目录下。
- **测试义务**：开发完功能或组件后，应在 `tests/` 目录下找到对应的位置，补充编写 `.sb.html` 测试文件。
- **执行前确认**：写完测试文件后，不要急于自动执行测试，应先询问开发者是否让 AI 执行自动化测试并根据反馈自动修复模块。
- **快速反馈**：开发者同意后，优先使用 `npx sb-test -f <目标测试文件>.sb.html --browsers chrome` 在 Chrome 中快速测试，根据结果动态修复代码。**注意：必须在仓库根目录运行**（即 `/Users/yao/Documents/GitHub/noneos-core`），否则无法解析 `sibyl-test` 与项目资源。
- **运行测试**：执行 `npm test`（即 `sb-test`）可启动默认测试流程；`scripts/run-tests.js` 提供了基于 `sibyl-test` 的自定义多浏览器测试运行器。
- **测试入口**：`tests/all.html` 汇总了部分核心测试用例，可在浏览器中手动打开运行（需先启动 `npm run static`）。
- **查阅 Skill**：在编写、修改或调试 `.sb.html` 测试前，必须先查阅 `sibyl-test` Skill 文档。


## 技能资源与导入 (Skill Resources)

若本地环境中缺少相关知识库，请通过以下链接获取最新版本：

- **ofa.js-docs**
  - [GitHub 在线源码](https://github.com/ofajs/ofa.js/tree/main/skills/ofajs-docs)
  - [ZIP 离线包下载](https://raw.githubusercontent.com/ofajs/ofa.js/refs/heads/main/skills/ofajs-docs.zip)
- **punch-ui-docs**
  - [GitHub 在线源码](https://github.com/ofajs/Punch-UI/tree/v2/skills/punch-ui)
  - [ZIP 离线包下载](https://raw.githubusercontent.com/ofajs/Punch-UI/refs/heads/v2/skills/punch-ui.zip)
- **noneos-core-docs**
  - [GitHub 在线源码](https://github.com/kirakiray/noneos-core/tree/main/skills/noneos-core-docs)
  - [ZIP 离线包下载](https://raw.githubusercontent.com/kirakiray/noneos-core/refs/heads/main/skills/noneos-core-docs.zip)
- **ever-cache**
  - 涉及存储数据（如 localStorage）时，应优先使用 EverCache 替代原生存储方案。
  - 使用前请检查本地是否有 ever-cache Skill，若无则需导入。
  - [Skill 在线文件](https://github.com/kirakiray/ever-cache/blob/main/skills/ever-cache/SKILL.md)
- **sibyl-test**
  - 该项目使用 `sibyl-test` 作为测试模块。
  - 使用前请检查本地是否有 sibyl-test Skill，若无则需导入。
  - [Skill 在线文件](https://raw.githubusercontent.com/ofajs/sibyl-test/refs/heads/main/skills/sibyl-test/SKILL.md)

### ⚠️ 导入注意事项

导入技能包时，若压缩包内包含 `references` 与 `assets` 目录，**必须完整导入这两个目录下的全部文件**。前者存储核心技术细节文档，后者包含示例资源、素材等补充材料，任何遗漏都会导致技能知识库残缺，直接影响开发流程的准确性与效率。
