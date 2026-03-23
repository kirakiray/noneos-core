// 并发管理模块
// 负责跟踪 API Key 的并发请求数和事件监听
// 支持跨标签页状态同步
// 使用 API Key 的唯一 ID（而非 API Key 字符串本身）作为并发跟踪的键
import { getLocaleText } from "/nos/locale-text/get-locale-text.js";

// 并发跟踪器：记录每个 API Key ID 的当前并发请求数和 provider
const concurrencyTracker = new Map();

// ID 到 Provider 的映射
const idToProviderMap = new Map();

// 并发事件监听器集合
const concurrencyListeners = new Set();

// 本标签页活跃请求跟踪器：记录本标签页发起的请求
// 结构: Map<id, Set<requestId>>
const localActiveRequests = new Map();

// 生成唯一请求 ID
function generateRequestId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}

// 跨标签页通信通道
const channel = new BroadcastChannel("ai-concurrency-sync");

// 触发并发变化事件
function emitConcurrencyEvent(event) {
  concurrencyListeners.forEach((listener) => {
    try {
      listener(event);
    } catch (error) {
      console.error(
        getLocaleText({
          cn: "并发事件监听器执行失败:",
          en: "Concurrency event listener execution failed:",
        }),
        error,
      );
    }
  });
}

// 广播并发变化到其他标签页
function broadcastChange(type, id, provider, current, previous, requestId) {
  channel.postMessage({
    type,
    id,
    provider,
    current,
    previous,
    requestId,
    timestamp: Date.now(),
  });
}

// 广播标签页关闭时的清理消息
function broadcastCleanup() {
  const cleanupData = [];
  localActiveRequests.forEach((requestIds, id) => {
    if (requestIds.size > 0) {
      cleanupData.push({
        id,
        provider: idToProviderMap.get(id) || "",
        count: requestIds.size,
      });
    }
  });

  if (cleanupData.length > 0) {
    channel.postMessage({
      type: "cleanup",
      data: cleanupData,
      timestamp: Date.now(),
    });
  }
}

// 标签页关闭时清理本标签页的活跃请求
window.addEventListener("beforeunload", () => {
  broadcastCleanup();
});

// 监听其他标签页的并发变化
channel.onmessage = (event) => {
  const { type, id, provider, current, previous, timestamp, data } =
    event.data;

  if (type === "cleanup") {
    data.forEach((item) => {
      const itemCurrent = concurrencyTracker.get(item.id) || 0;
      const newCount = itemCurrent - item.count;

      if (newCount <= 0) {
        concurrencyTracker.delete(item.id);
        idToProviderMap.delete(item.id);
      } else {
        concurrencyTracker.set(item.id, newCount);
      }

      emitConcurrencyEvent({
        type: "cleanup",
        key: item.id,
        provider: item.provider,
        current: newCount > 0 ? newCount : 0,
        previous: itemCurrent,
        timestamp,
        source: "remote",
      });
    });
    return;
  }

  if (type === "increment") {
    concurrencyTracker.set(id, current);
    if (provider) {
      idToProviderMap.set(id, provider);
    }
  } else if (type === "decrement") {
    if (current <= 0) {
      concurrencyTracker.delete(id);
      idToProviderMap.delete(id);
    } else {
      concurrencyTracker.set(id, current);
    }
  }

  emitConcurrencyEvent({
    type,
    key: id,
    provider,
    current,
    previous,
    timestamp,
    source: "remote",
  });
};

// 获取指定 Key ID 的当前并发数
export function getCurrentConcurrency(id) {
  return concurrencyTracker.get(id) || 0;
}

// 增加并发计数，返回请求 ID 用于后续清理
export function incrementConcurrency(id, provider) {
  const current = getCurrentConcurrency(id);
  const newCount = current + 1;
  concurrencyTracker.set(id, newCount);
  if (provider) {
    idToProviderMap.set(id, provider);
  }

  const requestId = generateRequestId();
  if (!localActiveRequests.has(id)) {
    localActiveRequests.set(id, new Set());
  }
  localActiveRequests.get(id).add(requestId);

  const timestamp = Date.now();

  broadcastChange("increment", id, provider, newCount, current, requestId);

  emitConcurrencyEvent({
    type: "increment",
    key: id,
    provider: provider,
    current: newCount,
    previous: current,
    timestamp,
    source: "local",
  });

  return requestId;
}

// 减少并发计数，计数为0时移除
export function decrementConcurrency(id, provider, requestId) {
  const current = getCurrentConcurrency(id);
  const newCount = current - 1;

  if (newCount <= 0) {
    concurrencyTracker.delete(id);
    idToProviderMap.delete(id);
  } else {
    concurrencyTracker.set(id, newCount);
  }

  if (requestId && localActiveRequests.has(id)) {
    localActiveRequests.get(id).delete(requestId);
    if (localActiveRequests.get(id).size === 0) {
      localActiveRequests.delete(id);
    }
  }

  const timestamp = Date.now();

  broadcastChange(
    "decrement",
    id,
    provider,
    newCount > 0 ? newCount : 0,
    current,
    requestId,
  );

  emitConcurrencyEvent({
    type: "decrement",
    key: id,
    provider: provider,
    current: newCount > 0 ? newCount : 0,
    previous: current,
    timestamp,
    source: "local",
  });
}

// 获取当前所有 Key ID 的并发状态
export function getConcurrencyStatus() {
  const status = {};
  concurrencyTracker.forEach((value, id) => {
    status[id] = {
      count: value,
      provider: idToProviderMap.get(id) || "",
    };
  });
  return status;
}

// 注册并发变化事件监听器
// @param {Function} listener - 事件监听函数，接收 { type, key, current, previous, timestamp }
// @returns {Function} unsubscribe - 取消监听的函数
export function subscribe(listener) {
  if (typeof listener !== "function") {
    throw new Error(
      getLocaleText({
        cn: "监听器必须是一个函数",
        en: "Listener must be a function",
      }),
    );
  }

  concurrencyListeners.add(listener);

  const unsubscribe = () => {
    concurrencyListeners.delete(listener);
  };

  return unsubscribe;
}
