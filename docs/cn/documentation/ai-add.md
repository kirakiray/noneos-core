# 添加 AI 模型

## AI 模型管理入口

在已经部署过的 NoneOS 系统内，基于系统开发的应用可以通过 `o-page` 组件引用 AI 模型的密钥管理页面来添加 AI 模型。

### 方式一：使用完整路径

如果应用未启用 `useNosTool` 模式，可以使用完整路径引入：

```html
<o-page src="https://core.noneos.com/nos-tool/ai/pages/key-manager.html"></o-page>
```

### 方式二：使用相对路径

如果 `sw.js` 中已经启用 `useNosTool` 模式，则可以直接使用相对路径：

```html
<o-page src="/nos-tool/ai/pages/key-manager.html"></o-page>
```

启用方式是在 `sw.js` 中添加：

```javascript
globalThis.SERVER_OPTIONS = {
  useNosTool: true,
};
```

这样就可以在你的 ofa.js 应用中直接加入添加 AI 模型的入口了。