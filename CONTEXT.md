# noneos-core 项目上下文

> 本文档供 AI 阅读，描述项目的客观情况（技术栈、目录结构、运行时路径映射、开发命令、模块清单）。**规则与约束请见 [AGENTS.md](AGENTS.md)**。

## 一、核心技术架构

- **底层架构 (Base Layer)**：基于 `noneos-core` 开发。
  - 涉及文件系统、用户管理及服务通信时，请参考 `noneos-core-docs` 知识库，它的地址在 .agents/skills/noneos-core-docs/SKILL.md。
- **应用框架 (Application Layer)**：基于 `ofa.js` 开发。
  - 进行组件开发、路由配置或状态管理时，请参考 `ofajs-docs` 知识库。

## 二、项目结构与运行时路径映射

> ⚠️ **关键概念**：仓库源码路径 ≠ 浏览器运行时 URL。本项目的 Service Worker 会将一组"虚拟 URL 前缀"映射到不同的后端（本地 OPFS / CDN / 官方源 / 远端用户）。**在仓库中查找文件时，永远以仓库目录结构为准，不要把运行时 URL 当作源码路径去搜索。**

### 源码目录（仓库内真实存在的文件）

| 目录 | 角色 |
|------|------|
| `nos/` | 核心能力层（fs/user/publish/storage/crypto/util/locale-text/n-icon，根证书 `root-cert.json`；另含 `hybrid-data`，⚠️ 为实验性特性，后续大概率迁移或淘汰） |
| `ncomp/` | 基于 nos 的公共 UI 组件（`<n-user-name>` / `<n-user-status>` 等） |
| `sw/` | Service Worker 源码（`sw/src/`，构建产物 `sw/dist.js`、`sw/dist.min.js`） |
| `server/handshake/` | Rust 服务端（WebSocket 握手/中继服务） |
| `server/client/` | 服务端管理前端（admin 页面） |
| `nos-tool/` | 内置工具集（studio、file-explore、system-info、locale-text-tool、rtc-tool，安装/升级入口 `_install/`）；任何基于 noneos-core 的系统都可通过 `/nos-tool/` 直接使用 |
| `docs/` | 多语言文档源（cn/en/ja）与构建产物 |
| `.agents/skills/` | Skill 知识库（`noneos-core-docs` 等） |
| `tests/` | sibyl-test 测试用例 |
| `scripts/` | 构建/打包/测试脚本 |
| `others/` | 归档/实验代码（如 `others/old/editor/` 旧 Monaco 编辑器），**不参与运行时** |

### 运行时虚拟路径（由 Service Worker 在运行时映射，**仓库内不存在**）

| URL 前缀 | 实际映射目标 | 处理器（sw/src/modules/） |
|----------|------------|---------------------------|
| `/nos/...` | online 模式（默认）直接同域 fetch；local 模式映射到 OPFS `systemConfig.nosMapPath`（如 `nos-{version}/`）；dev 时 localhost:3002 直连、其他 localhost 端口先代理到 3002 | nos-handle.js |
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
| (dev-bridge) | `systemConfig.devBridge` 配置非空时，对同域顶层 HTML 导航（GET + `destination === "document"`）在 `<head>` 开标签后注入调试 script 与防篡改开发模式警告横幅（横幅被移除则整页替换为恶意程序警告；无 `<head>` 的文档不注入）；生产配置无此字段即完全不生效 | dev-bridge.js（包装所有 handler 的响应） |

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
| `npm run static` | 启动静态文件服务器（`scripts/static.js`，同时监听两个端口：3002 常规开发；3003 独立 origin，供 dev-bridge 等会污染 origin 状态的测试使用） | `http://localhost:3002` / `http://localhost:3003` |
| `npm run test:dev-bridge` | 单独运行 dev-bridge 注入测试（自动在 3003 起测试服务器，Chrome） | — |
| `npm run ws1` | 启动主 WebSocket 服务（Rust） | `ws://localhost:8081` |
| `npm run ws2` | 启动备 WebSocket 服务（Rust，用于多服务器选路联调） | `ws://localhost:8082` |
| `npm run watch:sw` | 监听 `sw/src/**` 自动重建 SW（可与 static 合并成 `npm run dev`） | — |

便捷组合：
- `npm run dev` = `npm run static` + `npm run watch:sw`（不含 ws，需另起）
- `npm run ws` = `npm run ws1` + `npm run ws2`
- `npm start` = 本地正式部署用的静态服务器（`localhost:30028`，默认握手服务器会包含线上节点；同时也是自动化测试使用的端口）


**Rust 服务配置文件**：`server/handshake/test-space/config.example.toml`（ws1）与 `config2.toml`（ws2），测试环境已关闭内存过载保护、放宽 session/relay 限制。

### 构建

| 命令 | 作用 |
|------|------|
| `npm run build` | 完整构建 = `build:hashes` + `pack-nos.js` + `build:sw` + `build:skill` |
| `npm run build:sw` | 通过 Rollup 构建 SW（产出 `sw/dist.js` + `sw/dist.min.js`） |
| `npm run build:hashes` | 计算并签名 `nos/` 源码哈希（产出会被 `nos.json` 消费） |
| `npm run build:skill` | 构建 `.agents/skills/noneos-core-docs` 知识库（生成 `noneos-core-docs.zip`） |
| `npm test` | 运行 sibyl-test 测试套件（`sb-test`；自定义多浏览器运行器见 `scripts/run-tests.js`） |
| `npm run bump` | 升级版本号 = `bump.js` + `npm i` + `npm run build` |

> **重要**：修改 `sw/src/` 下任何文件后必须重新运行 `npm run build:sw`（或开发期使用 `npm run watch:sw`），否则线上 SW 不会生效。

## 四、CONTEXT.md 模块清单

各核心模块均提供 `CONTEXT.md` 供 AI 快速理解架构与实现，无需逐文件阅读源码。

### 已有 CONTEXT.md 的模块

- [nos/fs/CONTEXT.md](nos/fs/CONTEXT.md) - 文件系统（OPFS 虚拟 FS、挂载、跨标签页同步）
- [nos/user/CONTEXT.md](nos/user/CONTEXT.md) - 用户身份与通信（ECDSA 握手、中继、WebRTC、E2EE）
- [server/handshake/CONTEXT.md](server/handshake/CONTEXT.md) - 服务端实现（WebSocket、会话管理、流量统计、redb）
- [nos/publish/CONTEXT.md](nos/publish/CONTEXT.md) - 数据/应用发布（内容寻址、分块、签名清单）
- [nos/storage/CONTEXT.md](nos/storage/CONTEXT.md) - 官方键值存储（IndexedDB、类 localStorage、跨标签页同步、句柄序列化）
- [sw/CONTEXT.md](sw/CONTEXT.md) - Service Worker（请求拦截、资源代理、缓存策略）
- [ncomp/CONTEXT.md](ncomp/CONTEXT.md) - ncomp 公共组件目录（可复用的 nos 相关 UI 组件）

### 暂无 CONTEXT.md 的模块

修改这些模块时需逐文件阅读源码，建议在重大改动后补充 CONTEXT.md：

- `nos/crypto/`（5 个加密模块：AES/ECDH/ECDSA/RSA/verify）
- `nos/hybrid-data/`（混合数据，远端 + 本地）
- `nos/util/`（hash/zip/async-pool 等工具）
- `nos-tool/`（内置工具集：studio、file-explore、system-info、locale-text-tool、rtc-tool）
- `server/client/`（服务端管理前端 admin 页面）

## 五、多语言方案（locale-text）书写规范

多语言文案**必须严格按照以下格式书写**，才能被 `nos-tool/locale-text-tool` 扫描收录，进而在根目录生成 `locale-text.json`；拿到该 JSON 后即可用任意第三方工具（机翻服务、AI 辅助翻译等）批量补充 `ja`/`ko` 等语种，方便地为整个项目添加多国语言，无需改源码。

HTML 中（文案必须包在 `<locale-text>` 内，每语种一个带 `lang` 属性的子元素）：

```html
<locale-text>
  <span lang="cn">开始</span>
  <span lang="en">Get Started</span>
</locale-text>
```

脚本中（HTML 内联 `<script>` 或独立 `.js`/`.mjs` 文件均可，关键是必须通过 `getLocaleText` 函数调用；动态值用 `{key}` 占位符 + `vars`，不要用模板字符串插值）：

```javascript
import getLocaleText from "/nos/locale-text/get-locale-text.js";

getLocaleText({ cn: "保存失败", en: "Save failed" });
getLocaleText({ cn: "网络请求失败: {msg}", en: "Network failed: {msg}" }, { msg: err.message });
```

格式不规范的条目无法被工具收录，也就无法进入中央翻译表获得扩展语种。详见 [nos/locale-text/README.md](nos/locale-text/README.md)。
