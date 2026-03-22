// AI 聊天模块
// 支持多提供商 API Key 管理、并发控制、负载均衡、流式响应
import { storage } from "/gh/kirakiray/ever-cache/src/main.js";
import {
  getCurrentConcurrency,
  incrementConcurrency,
  decrementConcurrency,
  getConcurrencyStatus,
  bind,
  getConcurrencyListenerCount,
  clearConcurrencyListeners,
} from "./concurrency.js";

// 获取各 AI 提供商的 API 端点 URL
function getProviderBaseUrl(provider) {
  const urls = {
    deepseek: "https://api.deepseek.com/v1/chat/completions",
    kimi: "https://api.moonshot.cn/v1/chat/completions",
    glm: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
    minimax: "https://api.minimax.chat/v1/chat/completions",
  };
  return urls[provider] || "";
}

// 构建请求头（Bearer Token 认证）
function getProviderHeaders(provider, apiKey) {
  const headers = {
    "Content-Type": "application/json",
  };

  headers["Authorization"] = `Bearer ${apiKey}`;

  return headers;
}

// 获取 Key 简短标识符（前12字符），用于日志输出
function getKeyIdentifier(key) {
  if (!key || key.length <= 12) {
    return key || "";
  }
  return key.substring(0, 12) + "...";
}

// 创建格式化错误对象
function createError(provider, key, message) {
  const keyId = getKeyIdentifier(key);
  return new Error(`[Provider: ${provider}] [Key: ${keyId}] ${message}`);
}

// 从存储获取所有已配置的 API Keys
async function getAiKeys() {
  const keys = (await storage.getItem("ai-keys")) || [];
  return keys;
}

// 选择可用 API Key，按指定 provider 筛选，排除超并发 Key，随机选择
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

// 执行流式聊天请求，通过 SSE 流式读取响应，callback 实时返回内容片段
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
      `API 请求失败 (${response.status}): ${errorText}`,
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
            // 忽略单个数据块的解析错误
          }
        }
      }
    }
  } finally {
    decrementConcurrency(key, provider);
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

// 发送聊天请求（主入口）
// @param {Array} messages - 对话消息数组 [{role, content}]
// @param {Object} options - { provider?, callback? }
// @returns {Object} { provider, content, model }
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
        `没有找到 provider 为 ${specifiedProvider} 的 API Key`,
      );
    }
    throw new Error("没有可用的 API Key");
  }

  if (selectedKey.error === "concurrency_exceeded") {
    throw createError(
      specifiedProvider,
      "",
      "超出并发数限制，请稍后重试或使用其他 provider",
    );
  }

  if (selectedKey.error === "no_available_key") {
    throw new Error("所有 API Key 都已达到并发数上限，请稍后重试");
  }

  incrementConcurrency(selectedKey.key, selectedKey.provider);

  try {
    return await streamChat(messages, selectedKey, options);
  } catch (error) {
    decrementConcurrency(selectedKey.key, selectedKey.provider);
    throw error;
  }
}

// 获取已配置 API Key 的提供商列表
export async function getAvailableProviders() {
  const keys = await getAiKeys();
  const providers = [...new Set(keys.map((k) => k.provider))];
  return providers;
}

// 重新导出并发管理模块的函数
export { bind, getConcurrencyStatus, getConcurrencyListenerCount, clearConcurrencyListeners };
