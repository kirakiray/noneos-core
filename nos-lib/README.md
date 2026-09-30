# nos-lib

`nos-lib` 是 NoneOS Core 的**官方在线库**：由官方 CDN（`core.noneos.com`）分发、不进入 `nos.tgz` 签名包的公共资源。基于 `nos` 的上层项目可以通过 `/nos-lib/{path}` 路径直接引用。

## 目录内容

| 子目录 | 内容 |
|--------|------|
| [user-name/](user-name/) | `<n-user-name>` 公共组件：根据 `user-id` 显示对应用户的用户名 |
| [user-status/](user-status/) | `<n-user-status>` 公共组件：根据 `user-id` 显示对应用户的在线/连接状态（颜色圆点） |
| [nos-version/](nos-version/) | `<nos-version>` 公共组件：安装/版本入口组件（检查更新、触发安装/升级，事件驱动） |
| [_install/](_install/) | 安装/升级引导：SW 注册（`registerSw()`）、版本检查、完整系统安装、根证书信任链校验 |

## 设计原则

- **与 `nos/` 的边界**：必须随系统安装、参与哈希签名校验的核心能力一律放 `nos/`；官方在线分发的可复用资源放 `nos-lib/`。
- **克制收录**：只存放与 `nos` 核心能力强相关、在多个项目中会被高频复用的资源。
- **可定制性**：组件保持简洁，允许第三方基于它们做较大程度的定制和扩展。
- **命名规范**：nos 能力相关组件标签统一使用 `n-` 前缀（如 `n-user-name`）；`nos-version` 为历史沿用的例外。
- **路径稳定**：内部引用 `nos` 能力时使用绝对路径 `/nos/...`，确保在不同宿主项目中路径一致。

## 使用方式

NoneOS 宿主页面内引用：

```html
<l-m src="/nos-lib/user-name/user-name.html"></l-m>
<n-user-name user-id="{userId}"></n-user-name>
```

跨域页面（未安装 NoneOS Core 的站点）使用完整官方地址加载安装组件：

```html
<l-m src="https://core.noneos.com/nos-lib/nos-version/nos-version.html"></l-m>
<nos-version auto-install></nos-version>
```

## 旧前缀兼容

历史前缀 `/ncomp/`（原组件目录）、`/nos-tool/_install/` 与 `/nos-tool/comps/`（原安装引导与 nos-version 位置）仍可访问：

- **同域**（运行本 SW 的页面）：Service Worker 在分发时把 path 归一化为 `/nos-lib/` 新路径处理，OPFS 缓存键统一为新路径；
- **跨域直连**（第三方页面直接从 `core.noneos.com` 加载）：托管层 `_redirects` 返回 301 到新路径。

新代码请一律使用 `/nos-lib/` 前缀。
