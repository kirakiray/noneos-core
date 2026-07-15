# ncomp 公共组件

`ncomp`（NoneOS Components）是 NoneOS Core 的公共组件目录，存放与 `nos` 核心能力强相关的可复用 UI 组件。基于 `nos` 的上层项目可以通过 `/ncomp/{component}/{component}.html` 路径直接引用。

## 设计原则

- **克制收录**：只存放与 `nos` 核心能力强相关、在多个项目中会被高频复用的组件。
- **可定制性**：组件保持简洁，允许第三方基于它们做较大程度的定制和扩展。
- **命名规范**：组件标签统一使用 `n-` 前缀（如 `n-user-name`），避免与 HTML 原生标签或第三方组件冲突。
- **路径稳定**：组件内部引用 `nos` API 时使用绝对路径 `/nos/...`，确保在不同宿主项目中路径一致。

## 使用方式

```html
<l-m src="https://core.noneos.com/ncomp/user-name/user-name.html"></l-m>
<n-user-name user-id="{userId}"></n-user-name>
```

在本地开发时，也可以使用相对路径或 `/ncomp/...` 路径：

```html
<l-m src="/ncomp/user-name/user-name.html"></l-m>
```

## 组件列表

### `user-name`

根据 `user-id` 显示对应用户的用户名。

- **文件路径**：`/ncomp/user-name/user-name.html`
- **标签**：`<n-user-name>`
- **依赖**：`/nos/user/main.js`

#### 属性

| 属性名 | 默认值 | 说明 |
|--------|--------|------|
| `user-id` | `""` | 目标用户的 userId |
| `force` | `null` | 设置时强制触发在线名片刷新 |
| `namespace` | `"default"` | 用户命名空间 |

#### 功能说明

- 若目标用户就是当前本地用户，直接读取 `user.getInfo().username`。
- 否则读取本地名片缓存 `user.card.get(uid)` 中的 `username`。
- 设置 `force` 属性时，会尝试主动连接目标用户并刷新名片缓存，再显示最新名称。
- 名片获取失败时保持显示 `user-id`。

#### 使用示例

```html
<l-m src="/ncomp/user-name/user-name.html"></l-m>
<n-user-name user-id="xxxxxxxxxxxxxxxx"></n-user-name>
```

#### 注意事项

- 组件需要在已初始化 NoneOS Core 用户系统的页面中使用。
- `force` 刷新会尝试建立 P2P 连接，目标用户不在线时连接会失败，但组件仍会从名片缓存中读取。
