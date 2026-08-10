# noneos-core 项目上下文

> 本文档供 AI 阅读，描述项目的客观情况（技术栈、目录结构、运行时路径映射、开发命令、模块清单）。**规则与约束请见 [AGENTS.md](AGENTS.md)**。

## 一、核心技术架构

- **底层架构 (Base Layer)**：基于 `noneos-core` 开发。
  - 涉及文件系统、用户管理及服务通信时，请参考 `noneos-core-docs` 知识库，它的地址在 skills/noneos-core-docs/SKILL.md。
- **应用框架 (Application Layer)**：基于 `ofa.js` 开发。
  - 进行组件开发、路由配置或状态管理时，请参考 `ofajs-docs` 知识库。

## 二、项目结构与运行时路径映射

> ⚠️ **关键概念**：仓库源码路径 ≠ 浏览器运行时 URL。本项目的 Service Worker 会将一组"虚拟 URL 前缀"映射到不同的后端（本地 OPFS / CDN / 官方源 / 远端用户）。**在仓库中查找文件时，永远以仓库目录结构为准，不要把运行时 URL 当作源码路径去搜索。**

### 源码目录（仓库内真实存在的文件）

| 目录 | 角色 |
|------|------|
| `nos/` | 核心能力层（fs/user/publish/storage/crypto/util 等；另含 `hybrid-data` 与 `ai`，⚠️ 均为实验性特性，后续大概率迁移或淘汰） |
| `ncomp/` | 基于 nos 的公共 UI 组件（`<n-user-name>` / `<n-user-status>` 等） |
| `sw/` | Service Worker 源码（`sw/src/`，构建产物 `sw/dist.js`、`sw/dist.min.js`） |
| `server/rust/` | Rust 服务端（WebSocket 握手/中继服务） |
| `server/client/` | 服务端管理前端（admin 页面） |
| `nos-tool/` | 开发工具集（编辑器、studio、file-explore、安装/升级入口 `_install/`） |
| `docs/` | 多语言文档源（cn/en/ja）与构建产物 |
| `skills/` | Skill 知识库（`noneos-core-docs` 等） |
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
| `/__host-cache` | 特殊路由：返回宿主项目离线缓存状态（需 `HOST_CACHE_CONFIG`） | host-cache-handler.js |
| `/__update-host-cache` | 特殊路由：触发宿主项目离线缓存更新（需 `HOST_CACHE_CONFIG`） | host-cache-handler.js |
| (fallback) | 同域 GET 请求且路径在 host-cache manifest files 列表中时，从 OPFS 缓存返回 | host-cache-handler.js |

**举例**：`nos/fs/main.js` 中动态 `import("./fs-remote/main.js")` —— 这里的 `./fs-remote/main.js` 是运行时通过 SW 加载的远端 FS 模块，**本仓库内未提供源码**，请不要在仓库中搜索它。

### 根目录运行时文件（部署/入口产物，**非源码**）

| 文件 | 角色 | 是否需手动修改 |
|------|------|---------------|
| `/index.html` | 项目入口 HTML | 是（页面初始化逻辑） |
| `/sw.js` | SW 注册桥接文件，**内容仅一行** `importScripts("/sw/dist.js")` | 否（不要改成 dist.min.js） |
| `/nos.json` | 在线版本与哈希清单（构建产物，由 `scripts/pack-nos.js` 生成） | 否（构建生成） |
| `/nos.zip` | 系统文件压缩包（构建产物） | 否（构建生成） |
| `/404.html`、`/_redirects` | Cloud Pages 托管配置 | 视部署需求 |

## 三、开发与构建命令

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
- `npm start` = 本地正式部署用的静态服务器（`localhost:30028`，默认握手服务器会包含线上节点；同时也是自动化测试使用的端口）


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

## 四、CONTEXT.md 模块清单

各核心模块均提供 `CONTEXT.md` 供 AI 快速理解架构与实现，无需逐文件阅读源码。

### 已有 CONTEXT.md 的模块

- [nos/fs/CONTEXT.md](nos/fs/CONTEXT.md) - 文件系统（OPFS 虚拟 FS、挂载、跨标签页同步）
- [nos/user/CONTEXT.md](nos/user/CONTEXT.md) - 用户身份与通信（ECDSA 握手、中继、WebRTC、E2EE）
- [server/rust/CONTEXT.md](server/rust/CONTEXT.md) - 服务端实现（WebSocket、会话管理、流量统计、redb）
- [nos/publish/CONTEXT.md](nos/publish/CONTEXT.md) - 数据/应用发布（内容寻址、分块、签名清单）
- [nos/storage/CONTEXT.md](nos/storage/CONTEXT.md) - 官方键值存储（IndexedDB、类 localStorage、跨标签页同步、句柄序列化）
- [sw/CONTEXT.md](sw/CONTEXT.md) - Service Worker（请求拦截、资源代理、缓存策略）
- [ncomp/CONTEXT.md](ncomp/CONTEXT.md) - ncomp 公共组件目录（可复用的 nos 相关 UI 组件）

### 暂无 CONTEXT.md 的模块

修改这些模块时需逐文件阅读源码，建议在重大改动后补充 CONTEXT.md：

- `nos/crypto/`（5 个加密模块：AES/ECDH/ECDSA/RSA/verify）
- `nos/ai/`（AI 会话与并发控制）
- `nos/hybrid-data/`（混合数据，远端 + 本地）
- `nos/util/`（hash/zip/async-pool 等工具）
- `nos-tool/`（开发工具集：编辑器、studio、file-explore）
- `server/client/`（服务端管理前端 admin 页面）
