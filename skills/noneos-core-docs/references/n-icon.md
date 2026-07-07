# n-icon

NoneOS 的图标组件，支持通过 [Iconify](https://iconify.design/) 引用海量开源图标库。

## 标签

`<n-icon>`

## 属性 (attrs)

| 属性名 | 默认值 | 说明 |
|--------|--------|------|
| `icon` | `null` | 图标名称，格式为 `集合前缀:图标名`（如 `mdi:home`, `fa-solid:user`） |

## 功能特性

- **按需加载**：仅在设置 `icon` 属性时从 Iconify API 异步获取 SVG。
- **内置缓存**：组件内部维护一个全局 Promise 缓存，防止在同一页面中多次重复请求相同的图标。
- **样式继承**：图标颜色默认继承自父元素的 `color`，大小可通过 `font-size` 或直接设置组件的宽高控制。

## 使用示例

### 基本使用

通过 `icon` 属性指定要显示的图标：

```html
<l-m src="https://core.noneos.com/nos/n-icon/n-icon.html"></l-m>

<n-icon icon="mdi:home"></n-icon>
<n-icon icon="mdi:account-circle"></n-icon>
<n-icon icon="logos:javascript"></n-icon>
```

### 自定义样式

可以通过 CSS 控制图标的大小和颜色：

```html
<style>
  .big-red-icon {
    width: 48px;
    height: 48px;
    color: #ff4d4f;
  }
</style>

<n-icon icon="mdi:heart" class="big-red-icon"></n-icon>
```

### 动态切换图标

```html
<n-icon id="my-icon" icon="mdi:play-circle-outline"></n-icon>

<script>
  setTimeout(() => {
    $("#my-icon").icon = "mdi:pause-circle-outline";
  }, 2000);
</script>
```

## 注意事项

- 确保应用可以访问 `https://api.iconify.design` 域名。
- 图标名称必须符合 Iconify 的命名规范。你可以访问 [icon-sets.iconify.design](https://icon-sets.iconify.design/) 搜索可用图标。
