# 调用 AI 模型

## 引入 chat 模块

```javascript
import { chat, subscribe, getStatus, getAvailableProviders } from "/nos/ai/chat.js";
```

## 基本用法

`chat` 函数接受消息数组和选项对象：

```javascript
const messages = [
  { role: "user", content: "你好" }
];

const response = await chat(messages, {
  provider: "deepseek",  // 可选，指定提供商
  callback: (chunk) => {  // 可选，流式回调
    console.log(chunk);
  },
  maxContextLength: 8192  // 可选，最大上下文长度
});
```

## 支持的提供商

- **deepseek** - DeepSeek
- **kimi** - Kimi (Moonshot)
- **glm** - 智谱 GLM
- **minimax** - MiniMax

如果不指定 `provider`，系统会自动选择一个可用的 API Key。

## 消息格式

```javascript
const messages = [
  { role: "system", content: "你是一个有用的助手" },
  { role: "user", content: "你好" },
  { role: "assistant", content: "你好，有什么可以帮助你的吗？" },
  { role: "user", content: "解释一下什么是 AI" }
];
```

## 并发控制

NoneOS AI 模块支持并发控制，可以避免同一个 API Key 被过度使用。

### 获取当前状态

```javascript
const status = getStatus();
// 返回各 Key 的并发使用情况
```

### 订阅状态变化

```javascript
subscribe((newStatus) => {
  console.log("状态更新:", newStatus);
});
```

## 获取可用提供商

```javascript
const providers = await getAvailableProviders();
console.log(providers); // ["deepseek", "kimi", "glm", "minimax"]
```

## 错误处理

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
