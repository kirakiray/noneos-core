# nos-lib

`nos-lib` 是 NoneOS Core 的**官方在线库**：由官方 CDN（`core.noneos.com`）分发、不进入 `nos.tgz` 签名包的公共资源。基于 `nos` 的上层项目可以通过 `/nos-lib/{path}` 路径直接引用。

## 目录内容

| 子目录 | 内容 |
|--------|------|
| [nos-version/](nos-version/) | `<nos-version>` 公共组件：安装/版本入口组件（检查更新、触发安装/升级，事件驱动） |
| [locale-text/](locale-text/) | `<locale-text>` 轻量国际化组件与 `getLocaleText()` 运行时 |
| [n-icon/](n-icon/) | `<n-icon>` 图标组件（基于 `nos/storage` 做持久化缓存） |
| [_install/](_install/) | 安装/升级引导：SW 注册（`registerSw()`）、版本检查、完整系统安装、根证书信任链校验 |
| [nos-lib.json](nos-lib.json) | 签名文件清单（构建产物）：SW 在缓存 `nos-lib` 文件前验签 + 校验 hash |

## 设计原则

- **与 `nos/` 的边界**：必须随系统安装、参与哈希签名校验的核心能力一律放 `nos/`；官方在线分发的可复用资源放 `nos-lib/`。
- **克制收录**：只存放与 `nos` 核心能力强相关、在多个项目中会被高频复用的资源。
- **可定制性**：组件保持简洁，允许第三方基于它们做较大程度的定制和扩展。
- **命名规范**：nos 能力相关组件标签统一使用 `n-` 前缀（如 `n-icon`）；`nos-version` 为历史沿用的例外。
- **路径稳定**：内部引用 `nos` 能力时，SW 宿主内可用绝对路径 `/nos/...`；需要支持完整 CDN URL 直接加载的组件用相对路径 `../../nos/...`（`n-icon` 即属此类）。

## 使用方式

NoneOS 宿主页面内引用：

```html
<l-m src="/nos-lib/n-icon/n-icon.html"></l-m>
<n-icon icon="mdi:home"></n-icon>
```

跨域页面（未安装 NoneOS Core 的站点）使用完整官方地址加载安装组件：

```html
<l-m src="https://core.noneos.com/nos-lib/nos-version/nos-version.html"></l-m>
<nos-version auto-install></nos-version>
```

