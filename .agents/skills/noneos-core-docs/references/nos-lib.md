# nos-lib（官方在线库）

`nos-lib` 由官方 CDN `core.noneos.com` 分发，不进入 `nos.tgz` 签名包；通过 `/nos-lib/{path}` 引用。

## 当前组件

| 组件 | 路径 | 说明 |
|---|---|---|
| `<nos-version>` | `/nos-lib/nos-version/nos-version.html` | 安装/版本入口；`auto-install` 自动安装 |
| `<locale-text>` | `/nos-lib/locale-text/locale-text.html` | 多语言文本 |
| `<n-icon>` | `/nos-lib/n-icon/n-icon.html` | 图标 |
| 安装引导 | `/nos-lib/_install/` | Service Worker 注册与安装流程 |

旧 4.x 的 `<n-user-name>`、`<n-user-status>` 已随用户系统重写移除；5.0 的 peer 身份只提供 `userId`，应用需要用户名/资料时自行基于应用数据实现。

```html
<l-m src="/nos-lib/n-icon/n-icon.html"></l-m>
<n-icon name="home"></n-icon>
```

命名规范：nos 能力相关组件用 `n-` 前缀；`nos-version` 为历史例外。
