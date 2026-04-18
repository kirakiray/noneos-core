# Call AI Model

## Introducing the chat module

```javascript
import { chat, subscribe, getStatus, getAvailableProviders } from "/nos/ai/chat.js";
```

## Basic Usage

The `chat` function accepts a message array and an options object:

```javascript
const messages = [
  { role: "user", content: "Hello" }
];

const response = await chat(messages, {
  provider: "deepseek",  // optional, specify provider
  callback: (chunk) => {  // optional, streaming callback
    console.log(chunk);
  },
  maxContextLength: 8192  // optional, maximum context length
});
```

## Supported Providers

- **deepseek** - DeepSeek
- **kimi** - Kimi (Moonshot)
- **minimax** - MiniMax
- **glm** - Zhipu GLM

If `provider` is not specified, the system will automatically select an available API Key.

## Message Format

```javascript
const messages = [
  { role: "system", content: "You are a helpful assistant" },
  { role: "user", content: "Hello" },
  { role: "assistant", content: "Hello, how can I help you?" },
  { role: "user", content: "Explain what AI is" }
];
```

## Concurrency Control

The NoneOS AI module supports concurrency control, which can prevent the same API key from being overused.

### Get Current Status

```javascript
const status = getStatus();
// Returns the concurrent usage of each key
```

### Subscription Status Changes

```javascript
subscribe((newStatus) => {
  console.log("Status updated:", newStatus);
});
```

## Get Available Providers

```javascript
const providers = await getAvailableProviders();
console.log(providers); // ["deepseek", "kimi", "glm", "minimax"]
```

## Error Handling

```javascript
try {
  const response = await chat(messages);
} catch (error) {
  console.error(error.message);
}
```

Common Mistakes:- `no_key` - No API Key configured
- `no_provider_key` - No provider's API Key specified
- `concurrency_full` - The concurrency limit for this Key has been reached
- `Unsupported provider` - Unsupported provider