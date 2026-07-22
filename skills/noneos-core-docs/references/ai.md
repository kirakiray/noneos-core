> ⚠️ **实验性特性**：`ai` 模块当前为实验性质，后续大概率迁移至新位置或被淘汰，请勿在正式项目中依赖。

## AI 操作

### 添加 AI 模型

可以通过 `o-page` 组件引入密钥管理页面：

```html
<o-page src="https://core.noneos.com/nos-tool/ai/pages/key-manager.html"></o-page>
```

或使用相对路径：

```html
<o-page src="/nos-tool/ai/pages/key-manager.html"></o-page>
```

### 引入 chat 模块

```javascript
import { chat, subscribe, getStatus, getAvailableProviders } from "/nos/ai/chat.js";
```

### 基本用法

```javascript
const messages = [
  { role: "user", content: "你好" }
];

const response = await chat(messages, {
  provider: "deepseek",
  callback: (chunk) => {
    console.log(chunk);
  },
  maxContextLength: 8192
});
```

### 支持的提供商

- **deepseek** - DeepSeek
- **kimi** - Kimi (Moonshot)
- **minimax** - MiniMax
- **glm** - 智谱 GLM

### 消息格式

```javascript
const messages = [
  { role: "system", content: "你是一个有用的助手" },
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好，有什么可以帮助你的吗？" },
  { role: "user", content: "解释一下什么是 AI" }
];
```

### 并发控制

```javascript
const status = getStatus();

subscribe((newStatus) => {
  console.log("状态更新:", newStatus);
});
```

### 获取可用提供商

```javascript
const providers = await getAvailableProviders();
console.log(providers); // ["deepseek", "kimi", "glm", "minimax"]
```

### 错误处理

```javascript
try {
  const response = await chat(messages);
} catch (error) {
  console.error(error.message);
}
```

常见错误：
- `no_key` - 没有配置任何 API Key
- `no_provider_key` - 没有指定提供商的 API Key
- `concurrency_full` - 该 Key 的并发数已满
- `Unsupported provider` - 不支持的提供商
