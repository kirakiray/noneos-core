# ncomp

`ncomp`（NoneOS Components）是 NoneOS Core 的公共组件目录，提供与 `nos` 能力直接相关的可复用 UI 组件。基于 `nos` 的上层项目可以通过 `/ncomp/{component}/{component}.html` 路径直接引用。

## 设计原则

- **克制收录**：只存放与 `nos` 核心能力强相关、在多个项目中会被高频复用的组件。
- **可定制性**：组件保持简洁，允许第三方基于它们做较大程度的定制和扩展。
- **命名规范**：组件标签统一使用 `n-` 前缀（如 `n-user-name`），避免与 HTML 原生标签或第三方组件冲突。
- **路径稳定**：组件内部引用 `nos` API 时使用绝对路径 `/nos/...`，确保在不同宿主项目中路径一致。

## 使用方式

```html
<l-m src="/ncomp/user-name/user-name.html"></l-m>
<n-user-name user-id="{userId}"></n-user-name>
```

## 组件列表

| 组件 | 标签 | 说明 |
|------|------|------|
| [user-name](user-name/user-name.html) | `<n-user-name>` | 根据 `user-id` 显示对应用户的用户名 |
| [user-status](user-status/user-status.html) | `<n-user-status>` | 根据 `user-id` 显示对应用户的在线/连接状态（颜色圆点） |
