# Add AI Model

## AI Model Management Portal

In the deployed NoneOS system, applications developed based on this system can introduce the AI model key management page through the `o-page` component, allowing users to add and manage AI models via a graphical user interface (GUI).

### Using Relative Paths

```html
<o-page src="/nos-tool/ai/pages/key-manager.html"></o-page>
```

This way you can directly add an entry for AI models in your ofa.js application.

## js Add Model

You can directly manage AI models through JavaScript code without using the `o-page` component.

### Introducing the Storage Module

```javascript
import { storage } from "/gh/kirakiray/ever-cache/src/main.js";
```

### Save API Key

```javascript
const newKey = {
  id: `${Math.random().toString(36).slice(2, 11)}`,
  provider: "deepseek",  // deepseek | kimi | minimax | glm
  model: "deepseek-chat",
  key: "your-api-key-here",
  concurrency: 1,  // Concurrency count
};

// Get existing keys
const aiKeys = (await storage.getItem("ai-keys")) || [];

// Add new key
aiKeys.push(newKey);

// Save
await storage.setItem("ai-keys", aiKeys);
```

### Available Models by Provider

Available models refer to the documentation of each provider.

### Retrieve All Saved Keys

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
```

### Delete API Key

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
const index = aiKeys.findIndex((k) => k.id === "key-id");
if (index > -1) {
  aiKeys.splice(index, 1);
  await storage.setItem("ai-keys", aiKeys);
}
```

### Update the concurrency limit of the Key

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
const keyItem = aiKeys.find((k) => k.id === "key-id");
if (keyItem) {
  keyItem.concurrency = 3;  // Modify the concurrency
  await storage.setItem("ai-keys", aiKeys);
}
```

### Key Object Structure

| Attribute     | Type    | Description                               |
| ------------- | ------- | ---------------------------------- |
| `id`          | string  | Unique identifier                         |
| `provider`    | string  | Provider (deepseek/kimi/minimax/glm) |
| `model`       | string  | Model name                           |
| `key`         | string  | API Key                            |
| `concurrency` | number  | Maximum concurrency                         |
| `disabled`    | boolean | Whether disabled                           |