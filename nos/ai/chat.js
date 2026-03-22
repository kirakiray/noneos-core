import { storage } from "/gh/kirakiray/ever-cache/src/main.js";

const concurrencyTracker = new Map();

function getKeyIdentifier(key) {
  if (!key || key.length <= 12) {
    return key || "";
  }
  return key.substring(0, 12) + "...";
}

function getProviderBaseUrl(provider) {
  const urls = {
    deepseek: "https://api.deepseek.com/v1/chat/completions",
    kimi: "https://api.moonshot.cn/v1/chat/completions",
    glm: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    minimax: "https://api.minimax.chat/v1/chat/completions",
  };
  return urls[provider] || "";
}

function getProviderHeaders(provider, apiKey) {
  const headers = {
    "Content-Type": "application/json",
  };

  switch (provider) {
    case "deepseek":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "kimi":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "glm":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "minimax":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    default:
      headers["Authorization"] = `Bearer ${apiKey}`;
  }

  return headers;
}

function getCurrentConcurrency(key) {
  return concurrencyTracker.get(key) || 0;
}

function incrementConcurrency(key) {
  const current = getCurrentConcurrency(key);
  concurrencyTracker.set(key, current + 1);
}

function decrementConcurrency(key) {
  const current = getCurrentConcurrency(key);
  if (current <= 1) {
    concurrencyTracker.delete(key);
  } else {
    concurrencyTracker.set(key, current - 1);
  }
}

function createError(provider, key, message) {
  const keyId = getKeyIdentifier(key);
  return new Error(`[Provider: ${provider}] [Key: ${keyId}] ${message}`);
}

async function getAiKeys() {
  const keys = (await storage.getItem("ai-keys")) || [];
  return keys;
}

function selectAvailableKey(keys, provider) {
  if (provider) {
    const providerKeys = keys.filter((k) => k.provider === provider);
    if (providerKeys.length === 0) {
      return null;
    }
    const availableKeys = providerKeys.filter((k) => {
      const current = getCurrentConcurrency(k.key);
      return current < (k.concurrency || 1);
    });
    if (availableKeys.length === 0) {
      return { error: "concurrency_exceeded", provider };
    }
    const randomIndex = Math.floor(Math.random() * availableKeys.length);
    return availableKeys[randomIndex];
  }

  const availableKeys = keys.filter((k) => {
    const current = getCurrentConcurrency(k.key);
    return current < (k.concurrency || 1);
  });

  if (availableKeys.length === 0) {
    return { error: "no_available_key" };
  }

  const randomIndex = Math.floor(Math.random() * availableKeys.length);
  return availableKeys[randomIndex];
}

async function streamChat(messages, keyItem, options = {}) {
  const { provider, key, model } = keyItem;
  const { callback } = options;

  const url = getProviderBaseUrl(provider);
  const headers = getProviderHeaders(provider, key);

  const body = {
    model: model,
    messages: messages,
    stream: true,
  };

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw createError(provider, key, `网络请求失败: ${err.message}`);
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw createError(
      provider,
      key,
      `API 请求失败 (${response.status}): ${errorText}`
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let fullContent = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmedLine = line.trim();
        if (!trimmedLine || trimmedLine === "data: [DONE]") continue;

        if (trimmedLine.startsWith("data: ")) {
          const jsonStr = trimmedLine.slice(6);
          try {
            const data = JSON.parse(jsonStr);
            const content = data.choices?.[0]?.delta?.content || "";
            if (content) {
              fullContent += content;
              if (callback) {
                callback({
                  provider: provider,
                  content: content,
                  fullContent: fullContent,
                  done: false,
                });
              }
            }
          } catch (e) {
            // ignore parse errors for individual chunks
          }
        }
      }
    }
  } finally {
    decrementConcurrency(key);
  }

  if (callback) {
    callback({
      provider: provider,
      content: "",
      fullContent: fullContent,
      done: true,
    });
  }

  return {
    provider: provider,
    content: fullContent,
    model: model,
  };
}

export async function chat(messages, options = {}) {
  const { provider: specifiedProvider, callback } = options;

  const keys = await getAiKeys();

  if (keys.length === 0) {
    throw new Error("没有可用的 API Key，请先在 key-manager 中添加 API Key");
  }

  const selectedKey = selectAvailableKey(keys, specifiedProvider);

  if (!selectedKey) {
    if (specifiedProvider) {
      throw createError(
        specifiedProvider,
        "",
        `没有找到 provider 为 ${specifiedProvider} 的 API Key`
      );
    }
    throw new Error("没有可用的 API Key");
  }

  if (selectedKey.error === "concurrency_exceeded") {
    throw createError(
      specifiedProvider,
      "",
      "超出并发数限制，请稍后重试或使用其他 provider"
    );
  }

  if (selectedKey.error === "no_available_key") {
    throw new Error("所有 API Key 都已达到并发数上限，请稍后重试");
  }

  incrementConcurrency(selectedKey.key);

  try {
    return await streamChat(messages, selectedKey, options);
  } catch (error) {
    decrementConcurrency(selectedKey.key);
    throw error;
  }
}

export function getConcurrencyStatus() {
  const status = {};
  concurrencyTracker.forEach((value, key) => {
    status[getKeyIdentifier(key)] = value;
  });
  return status;
}

export async function getAvailableProviders() {
  const keys = await getAiKeys();
  const providers = [...new Set(keys.map((k) => k.provider))];
  return providers;
}
