# sw.js 配置技巧

## 版本号控制与缓存更新

在发布新版本时，如果服务器配置了 `max-age=0` 响应头，浏览器仍可能缓存旧版本的 `sw.js` 文件，导致更新无法及时生效。通过在 URL 中添加版本参数，可以强制浏览器请求最新的文件，从而解决这一问题。

```javascript
let version = "";
if (globalThis.serviceWorker) {
  const urlParams = new URLSearchParams(
    new URL(serviceWorker.scriptURL).search,
  );
  version = urlParams.get("v") || "";
} else {
  const urlParams = new URLSearchParams(new URL(location.href).search);
  version = urlParams.get("v") || "";
}

importScripts("https://core.noneos.com/sw/dist.js?v=" + version);
```

在引用 dist.js 时加上 `?v=` 参数，每次发布新版本时更新版本号，浏览器便会请求新的文件而非使用缓存。

## 启用开发者工具

在 `sw.js` 中，通过 `globalThis.SERVER_OPTIONS` 可以启用 NoneOS 提供的开发者工具：

```javascript
globalThis.SERVER_OPTIONS = {
  useNosTool: true,
};
```

启用后，页面将加载 NoneOS 开发者工具模块。

## 可用的工具模块

`sw/dist.js` 会根据配置加载以下工具：

- **ai** - AI 模型管理，包括聊天、配置、密钥管理
- **editor** - Monaco 编辑器集成，支持代码高亮、格式化、AI 补全
- **file-explore** - 文件浏览器
- **file-list** - 文件列表视图和句柄管理
- **studio** - 开发工作室，提供文件管理、颜色工具、主题编辑等功能

这些工具位于 `nos-tool` 目录下，可按需引入和使用。
