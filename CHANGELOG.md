# Changelog

本项目的主要变更记录。版本号遵循语义化版本。

## [5.0.0] - 2026-11-15

### Removed

- **管理端**：删除已废弃的 `get_traffic_history` admin 命令及其流量历史页面、客户端方法与测试引用。
- **`connect()`**：删除旧版「第二参传数字作为重试次数」的兼容写法，只接受 `{ retries, auto }`。
- **`nos-tool/studio`**：移除 OFA Studio 工具及入口。
- **`nos/hybrid-data`**：移除实验性混合数据模块。
- **`docs/`**：移除多语言文档站点及其构建产物。
- **旧 URL 前缀兼容**：移除 `/ncomp/`、`/nos-tool/_install/`、`/nos-tool/comps/`、`/nos/locale-text/`、`/nos/n-icon/` 的 SW 归一化与托管层 301（`_redirects` 已删除）。
- **旧配置布局**：Service Worker 不再回退读取 OPFS 根目录 `nos-config/system.json`，只读 `nos/nos-config/system.json`。
- **依赖/脚本**：移除 `selenium-webdriver`、`@rollup/plugin-commonjs`、`@rollup/plugin-node-resolve` 与 `scripts/generate-test-html.js`。
- **归档**：移除 `others/` 下的 Rust 学习工程。
- **`locale-text.json`**：清理已删除页面遗留的 55 条孤儿词条（96 → 41）。

### Changed

- **`nos/locale-text`、`nos/n-icon`**：迁移到 `nos-lib/`，路径分别为 `/nos-lib/locale-text/`、`/nos-lib/n-icon/`。
- **`nos-lib` 签名机制**：新增 `nos-lib/nos-lib.json`（逐文件 SHA-256 + 根密钥签名 + 单调版本）；Service Worker 在写入 OPFS 缓存前执行 pin 校验、验签、hash 比对，并防清单回滚；开发环境（localhost / 127.0.0.1 / [::1]）跳过校验。
- **构建**：`build:hashes` 同时签发 `nos.json` 与 `nos-lib/nos-lib.json`；打包与清单排除 `*.md`、`*.sb.html`（`nos.tgz` 由 48 个文件降至 40 个）。
- **构建产物**：版本号升级到 **5.0.0**。

### Fixed

- README 目录树 `server/rust/` → `server/handshake/`，版本徽章同步。
- AGENTS.md 中机器专属绝对路径改为「仓库根目录」。
- `test-index.html` 补入 `tests/sw/noslib-manifest.sb.html`。

### Breaking Changes

- 旧前缀 `/ncomp/`、`/nos-tool/_install/`、`/nos-tool/comps/`、`/nos/locale-text/`、`/nos/n-icon/` 不再可用，请统一使用 `/nos-lib/`。
- 旧版安装在 OPFS 根目录的 `nos-config/system.json` 不再被读取。
