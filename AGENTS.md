# AI 代理开发指南 (AGENTS.md)

本文件为参与此项目开发的 AI 代理提供核心技术栈上下文和开发规范。在开始任何开发任务前，请务必遵循以下准则。

## 核心技术架构

- **底层架构 (Base Layer)**：基于 `noneos-core` 开发。
  - 涉及文件系统、用户管理及服务通信时，请参考 `noneos-core-docs` 知识库，它的地址在 skills/noneos-core-docs/SKILL.md。
- **应用框架 (Application Layer)**：基于 `ofa.js` 开发。
  - 进行组件开发、路由配置或状态管理时，请参考 `ofajs-docs` 知识库。
- **本地存储 (Storage Layer)**：统一使用项目内置的 `nos/storage`。
  - 涉及持久化数据（原本会用 `localStorage` 或手写 IndexedDB 的场景）时，一律改用 `nos/storage`，不要引入第三方存储库。
  - 用法见 `nos/storage/README.md`，实现细节见 `nos/storage/CONTEXT.md`，Skill 文档见 `skills/noneos-core-docs/references/storage.md`。

> 项目的技术栈细节、目录结构、运行时路径映射、开发命令见根目录 [CONTEXT.md](CONTEXT.md)。

## UI 与视觉规范

- **组件库**：项目统一使用 `senti-ui` 组件库（`st-*` 组件，基于 ofa.js + Material Design 3，CDN 引入即用）。
- **版本策略**：senti-ui 引用**始终使用 `@latest`，不锁定版本**——页面/组件模块用 `/gh/ofajs/senti-ui@latest/packages/...`（本地前缀，SW 拦截）；SW 就绪前就要渲染的静态入口页（根 `index.html`、`404.html`）用完整 URL `https://cdn.jsdelivr.net/gh/ofajs/senti-ui@latest/...`。禁止出现 `@1.0.x` 等锁版本写法。
- **视觉系统**：严格遵循 `senti-ui` 的颜色方案与设计语言，颜色一律消费 `--md-sys-color-*` M3 角色变量，不写死色值。
- **开发参考**：在实现 UI 相关功能前，请查阅 `senti-ui` 的 Skill 知识库以保持风格一致性。

## 开发指令

1. **先读项目 CONTEXT（首次进入项目时）**：第一次接触本项目时，必须先阅读根目录的 [CONTEXT.md](CONTEXT.md)，了解项目结构、运行时路径映射、开发命令与模块清单。
2. **先读 Skill**：在编写代码或提供建议前，必须先检索并阅读上述对应的 Skill 文档。
3. **遵循模式**：优先采用框架推荐的最佳实践，确保与现有代码库的风格一致。
4. **架构对齐**：所有改动需符合 `noneos-core` 与 `ofa.js` 的设计哲学。
5. **善用 CONTEXT**：项目根目录与各核心模块均提供 `CONTEXT.md` 供 AI 快速理解架构与实现，无需逐文件阅读源码。具体清单与模块职责见 [CONTEXT.md 第四节](CONTEXT.md#四contextmd-模块清单)。
6. **同步 CONTEXT**：若上述模块发生代码改动，**必须同步更新对应模块的 `CONTEXT.md`**，保持文档与源码一致。
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
   - **审查时机**：若发现 CONTEXT.md 与源码不一致（即使非本次改动），应按第 9 条补充完善。
7. **同步 Skill 文档**：对外可见行为发生变化后，**必须同步更新 `skills/noneos-core-docs/references/` 下对应的参考文档**，确保 Skill 知识库与源码保持一致。触发条件包括：
   - `nos/` 下模块的导出方法、参数、行为语义变化
   - `ncomp/` 新增/删除/修改公共组件（标签名、属性、事件）
   - `sw/` 路由策略或路径前缀变化
   - `server/rust/` admin 命令、消息协议字段、配置项变化
   - CONTEXT.md 中标注为"关键 API"的任何改动
8. **禁止使用 file 协议路径**：AI 书写的任何上下文、文档、注释、配置中的文件引用，一律禁止出现 `file://` / `file:///` 等本地绝对路径协议；项目内的文件引用统一使用相对路径或相对于仓库根目录的地址（如 `AGENTS.md`、`apps/main/home.html`、`nos/locale-text/README.md`），以免在不同机器上失效。
9. **补充上下文**：若发现 `CONTEXT.md` 中存在信息缺失，应及时补充完善。
10. **AI 常见误判清单**（基于历史踩坑总结，遇到这些情况请额外警惕）：
    - ❌ 把运行时虚拟 URL（`/packages/...`、`/nos/...`、`/gh/...`、`/npm/...`）当作仓库源码路径去查找 → ✅ 应对照 [CONTEXT.md 第二节](CONTEXT.md#二项目结构与运行时路径映射)，把它们映射回真实源码路径
    - ❌ 以为 `index.html` 注册了 Service Worker → ✅ 实际是 `nos-tool/_install/main.js`（生产）或 `nos-tool/_install/register.js`（测试）通过 `registerSw("sw.js")` 注册
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
- **senti-ui**
  - [Skill 在线源码目录](https://github.com/ofajs/senti-ui/tree/main/.agents/skills/senti-ui)
  - [ZIP 离线包下载](https://raw.githubusercontent.com/ofajs/senti-ui/refs/heads/main/.agents/skills/senti-ui-skill.zip)
- **noneos-core-docs**
  - [GitHub 在线源码](https://github.com/kirakiray/noneos-core/tree/main/skills/noneos-core-docs)
  - [ZIP 离线包下载](https://raw.githubusercontent.com/kirakiray/noneos-core/refs/heads/main/skills/noneos-core-docs.zip)
- **sibyl-test**
  - 该项目使用 `sibyl-test` 作为测试模块。
  - 使用前请检查本地是否有 sibyl-test Skill，若无则需导入。
  - [Skill 在线文件](https://raw.githubusercontent.com/ofajs/sibyl-test/refs/heads/main/skills/sibyl-test/SKILL.md)

### ⚠️ 导入注意事项

导入技能包时，若压缩包内包含 `references` 与 `assets` 目录，**必须完整导入这两个目录下的全部文件**。前者存储核心技术细节文档，后者包含示例资源、素材等补充材料，任何遗漏都会导致技能知识库残缺，直接影响开发流程的准确性与效率。
