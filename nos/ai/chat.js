// AI 聊天模块
// 支持多提供商 API Key 管理、并发控制、负载均衡、流式响应

import { storage } from "/gh/kirakiray/ever-cache/src/main.js";
import { getLocaleText } from "/nos/locale-text/get-locale-text.js";
import { getCount, inc, dec, getStatus, subscribe } from "./concurrency.js";

// 导出并发管理
export { subscribe, getStatus };

// 提供商 API 端点
const PROVIDER_URLS = {
  deepseek: "https://api.deepseek.com/v1/chat/completions",
  kimi: "https://api.moonshot.cn/v1/chat/completions",
  glm: "https://open.bigmodel.cn/api/paas/v4/chat/completions",
  minimax: "https://api.minimax.chat/v1/chat/completions",
};

// 获取请求头
const getHeaders = (apiKey) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer ${apiKey}`,
});

// 创建错误对象
const createError = (provider, key, msg) => {
  const keyId = key?.length > 12 ? key.slice(0, 12) + "..." : key || "";
  return new Error(`[${provider}] [${keyId}] ${msg}`);
};

// 获取所有 API Keys
const getKeys = async () => (await storage.getItem("ai-keys")) || [];

// 选择可用 Key
const selectKey = (keys, provider) => {
  const filtered = provider
    ? keys.filter((k) => k.provider === provider)
    : keys;

  if (filtered.length === 0) {
    return provider ? { error: "no_provider_key" } : { error: "no_key" };
  }

  const available = filtered.filter(
    (k) => getCount(k.id) < (k.concurrency || 1),
  );

  if (available.length === 0) {
    return { error: "concurrency_full" };
  }

  return available[Math.floor(Math.random() * available.length)];
};

// 流式聊天
const streamChat = async (messages, keyItem, options = {}) => {
  const { provider, key, model, id } = keyItem;
  const { callback, requestId } = options;

  const url = PROVIDER_URLS[provider];
  if (!url) {
    throw createError(
      provider,
      key,
      getLocaleText({ cn: "不支持的提供商", en: "Unsupported provider" }),
    );
  }

  let response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: getHeaders(key),
      body: JSON.stringify({ model, messages, stream: true }),
    });
  } catch (err) {
    throw createError(
      provider,
      key,
      getLocaleText({
        cn: `网络请求失败: ${err.message}`,
        en: `Network failed: ${err.message}`,
      }),
    );
  }

  if (!response.ok) {
    const errorText = await response.text();
    throw createError(
      provider,
      key,
      getLocaleText({
        cn: `API 失败 (${response.status})`,
        en: `API failed (${response.status})`,
      }) + `: ${errorText}`,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let content = "";
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;

        if (trimmed.startsWith("data: ")) {
          try {
            const data = JSON.parse(trimmed.slice(6));
            const chunk = data.choices?.[0]?.delta?.content || "";
            if (chunk) {
              content += chunk;
              callback?.({ provider, id, model, chunk, content, done: false });
            }
          } catch (e) {}
        }
      }
    }
  } finally {
    dec(id, requestId);
  }

  callback?.({ provider, id, model, chunk: "", content, done: true });
  return { provider, id, model, content };
};

// 发送聊天请求（主入口）
export async function chat(messages, options = {}) {
  const { provider: specifiedProvider, callback } = options;

  const keys = await getKeys();
  if (keys.length === 0) {
    throw new Error(
      getLocaleText({ cn: "没有可用的 API Key", en: "No available API Key" }),
    );
  }

  const selected = selectKey(keys, specifiedProvider);

  if (selected.error === "no_provider_key") {
    throw createError(
      specifiedProvider,
      "",
      getLocaleText({
        cn: `没有 ${specifiedProvider} 的 API Key`,
        en: `No API Key for ${specifiedProvider}`,
      }),
    );
  }

  if (selected.error === "no_key") {
    throw new Error(
      getLocaleText({ cn: "没有可用的 API Key", en: "No available API Key" }),
    );
  }

  if (selected.error === "concurrency_full") {
    throw createError(
      specifiedProvider || "",
      "",
      getLocaleText({
        cn: "并发数已满，请稍后重试",
        en: "Concurrency limit reached, please retry later",
      }),
    );
  }

  const requestId = inc(selected.id, selected.provider);

  try {
    return await streamChat(messages, selected, { ...options, requestId });
  } catch (error) {
    dec(selected.id, requestId);
    throw error;
  }
}

// 获取已配置的提供商列表
export const getAvailableProviders = async () => {
  const keys = await getKeys();
  return [...new Set(keys.map((k) => k.provider))];
};
