# 添加 AI 模型

## AI 模型管理入口

在已部署的 NoneOS 系统中，基于该系统开发的应用可以通过 `o-page` 组件引入 AI 模型的密钥管理页面，让用户以图形化界面（GUI）的方式添加和管理 AI 模型。

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

这样就可以在你的 ofa.js 应用中直接加入添加 AI 模型的入口了。

## js添加模型

你可以不使用 `o-page` 组件，通过 JavaScript 代码直接管理 AI 模型。

### 引入存储模块

```javascript
import { storage } from "/gh/kirakiray/ever-cache/src/main.js";
```

### 保存 API Key

```javascript
const newKey = {
  id: `${Math.random().toString(36).slice(2, 11)}`,
  provider: "deepseek",  // deepseek | kimi | minimax | glm
  model: "deepseek-chat",
  key: "your-api-key-here",
  concurrency: 1,  // 并发数
};

// 获取现有 keys
const aiKeys = (await storage.getItem("ai-keys")) || [];

// 添加新 key
aiKeys.push(newKey);

// 保存
await storage.setItem("ai-keys", aiKeys);
```

### 各提供商的可用模型

可用模型参考各提供商的文档。

### 获取所有已保存的 Keys

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
```

### 删除 API Key

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
const index = aiKeys.findIndex((k) => k.id === "key-id");
if (index > -1) {
  aiKeys.splice(index, 1);
  await storage.setItem("ai-keys", aiKeys);
}
```

### 更新 Key 的并发数

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
const keyItem = aiKeys.find((k) => k.id === "key-id");
if (keyItem) {
  keyItem.concurrency = 3;  // 修改并发数
  await storage.setItem("ai-keys", aiKeys);
}
```

### Key 对象结构

| 属性 | 类型 | 说明 |
|------|------|------|
| `id` | string | 唯一标识符 |
| `provider` | string | 提供商 (deepseek/kimi/minimax/glm) |
| `model` | string | 模型名称 |
| `key` | string | API Key |
| `concurrency` | number | 最大并发数 |
| `disabled` | boolean | 是否禁用 |

