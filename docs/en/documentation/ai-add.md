# Add AI Model

## AI Model Management Portal

In a deployed NoneOS system, applications developed based on the system can introduce an AI model's key management page through the `o-page` component, allowing users to add and manage AI models through a graphical user interface (GUI).

### Using Relative Paths

```html
<o-page src="/nos-tool/ai/pages/key-manager.html"></o-page>
```

This way, you can directly add an entry point for adding AI models in your ofa.js application.

## Adding Models in js

You can manage AI models directly through JavaScript code without using the `o-page` component.

### Import Storage Module

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

Refer to the documentation of each provider for available models.

### Get all saved Keys

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

### Concurrency of updating keys

```javascript
const aiKeys = (await storage.getItem("ai-keys")) || [];
const keyItem = aiKeys.find((k) => k.id === "key-id");
if (keyItem) {
  keyItem.concurrency = 3;  // Modify concurrency
  await storage.setItem("ai-keys", aiKeys);
}
```

### Key Object Structure

| Property      | Type    | Description                         |
| ------------- | ------- | ----------------------------------- |
| `id`          | string  | Unique identifier                   |
| `provider`    | string  | Provider (deepseek/kimi/minimax/glm)|
| `model`       | string  | Model name                          |
| `key`         | string  | API Key                             |
| `concurrency` | number  | Max concurrency                      |
| `disabled`    | boolean | Is disabled                         |