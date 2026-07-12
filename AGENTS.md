# AI 代理开发指南 (AGENTS.md)

本文件为参与此项目开发的 AI 代理提供核心技术栈上下文和开发规范。在开始任何开发任务前，请务必遵循以下准则。

## 核心技术架构

- **底层架构 (Base Layer)**：基于 `noneos-core` 开发。
  - 涉及文件系统、用户管理及服务通信时，请参考 `noneos-core-docs` 知识库，它的地址在 skills/noneos-core-docs/SKILL.md。
- **应用框架 (Application Layer)**：基于 `ofa.js` 开发。
  - 进行组件开发、路由配置或状态管理时，请参考 `ofajs-docs` 知识库。

## UI 与视觉规范

- **组件库**：项目深度集成 `punch-ui` 组件库。
- **视觉系统**：严格遵循 `punch-ui` 的颜色方案与设计语言。
- **开发参考**：在实现 UI 相关功能前，请查阅 `punch-ui` 知识库以保持风格一致性。

## 开发指令

1. **先读 Skill**：在编写代码或提供建议前，必须先检索并阅读上述对应的 Skill 文档。
2. **遵循模式**：优先采用框架推荐的最佳实践，确保与现有代码库的风格一致。
3. **架构对齐**：所有改动需符合 `noneos-core` 与 `ofa.js` 的设计哲学。
4. **善用 CONTEXT**：各核心模块均提供 `CONTEXT.md` 供 AI 快速理解架构与实现，无需逐文件阅读源码：
   - [nos/fs/CONTEXT.md](nos/fs/CONTEXT.md) - 文件系统（OPFS 虚拟 FS、挂载、跨标签页同步）
   - [nos/user/CONTEXT.md](nos/user/CONTEXT.md) - 用户身份与通信（ECDSA 握手、中继、WebRTC、E2EE）
   - [server/rust/CONTEXT.md](server/rust/CONTEXT.md) - 服务端实现（WebSocket、会话管理、流量统计、redb）
   - [nos/publish/CONTEXT.md](nos/publish/CONTEXT.md) - 数据/应用发布（内容寻址、分块、签名清单）
5. **同步 CONTEXT**：若上述模块发生代码改动，**必须同步更新对应模块的 `CONTEXT.md`**，保持文档与源码一致，避免后续 AI 基于过时信息工作。
6. **禁止使用 file 协议路径**：文档、注释、配置中的文件引用统一使用相对路径或仓库内可解析的路径（如 `AGENTS.md`、`apps/main/home.html`），禁止使用 `file://` 等本地绝对路径，避免在不同机器上失效。
7. **补充上下文**：若发现 `CONTEXT.md` 中存在信息缺失，应及时补充完善。


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

### ⚠️ 导入注意事项

导入技能包时，若压缩包内包含 `references` 与 `assets` 目录，**必须完整导入这两个目录下的全部文件**。前者存储核心技术细节文档，后者包含示例资源、素材等补充材料，任何遗漏都会导致技能知识库残缺，直接影响开发流程的准确性与效率。
