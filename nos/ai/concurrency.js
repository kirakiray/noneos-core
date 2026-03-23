// 并发管理模块
// 负责跟踪 API Key 的并发请求数和事件监听
// 支持跨标签页状态同步

// 并发跟踪器：记录每个 API Key 的当前并发请求数和 provider
const concurrencyTracker = new Map();

// Key 到 Provider 的映射
const keyToProviderMap = new Map();

// 并发事件监听器集合
const concurrencyListeners = new Set();

// 本标签页活跃请求跟踪器：记录本标签页发起的请求
// 结构: Map<key, Set<requestId>>
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
      console.error("并发事件监听器执行失败:", error);
    }
  });
}

// 广播并发变化到其他标签页
function broadcastChange(type, key, provider, current, previous, requestId) {
  channel.postMessage({
    type,
    key,
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
  localActiveRequests.forEach((requestIds, key) => {
    if (requestIds.size > 0) {
      cleanupData.push({
        key,
        provider: keyToProviderMap.get(key) || "",
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
  const { type, key, provider, current, previous, timestamp, data } =
    event.data;

  if (type === "cleanup") {
    data.forEach((item) => {
      const itemCurrent = concurrencyTracker.get(item.key) || 0;
      const newCount = itemCurrent - item.count;

      if (newCount <= 0) {
        concurrencyTracker.delete(item.key);
        keyToProviderMap.delete(item.key);
      } else {
        concurrencyTracker.set(item.key, newCount);
      }

      emitConcurrencyEvent({
        type: "cleanup",
        key: getKeyIdentifier(item.key),
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
    concurrencyTracker.set(key, current);
    if (provider) {
      keyToProviderMap.set(key, provider);
    }
  } else if (type === "decrement") {
    if (current <= 0) {
      concurrencyTracker.delete(key);
      keyToProviderMap.delete(key);
    } else {
      concurrencyTracker.set(key, current);
    }
  }

  emitConcurrencyEvent({
    type,
    key: getKeyIdentifier(key),
    provider,
    current,
    previous,
    timestamp,
    source: "remote",
  });
};

// 获取 Key 简短标识符（前12字符），用于日志输出
function getKeyIdentifier(key) {
  if (!key || key.length <= 12) {
    return key || "";
  }
  return key.substring(0, 12) + "...";
}

// 获取指定 Key 的当前并发数
export function getCurrentConcurrency(key) {
  return concurrencyTracker.get(key) || 0;
}

// 增加并发计数，返回请求 ID 用于后续清理
export function incrementConcurrency(key, provider) {
  const current = getCurrentConcurrency(key);
  const newCount = current + 1;
  concurrencyTracker.set(key, newCount);
  if (provider) {
    keyToProviderMap.set(key, provider);
  }

  const requestId = generateRequestId();
  if (!localActiveRequests.has(key)) {
    localActiveRequests.set(key, new Set());
  }
  localActiveRequests.get(key).add(requestId);

  const timestamp = Date.now();

  broadcastChange("increment", key, provider, newCount, current, requestId);

  emitConcurrencyEvent({
    type: "increment",
    key: getKeyIdentifier(key),
    provider: provider,
    current: newCount,
    previous: current,
    timestamp,
    source: "local",
  });

  return requestId;
}

// 减少并发计数，计数为0时移除
export function decrementConcurrency(key, provider, requestId) {
  const current = getCurrentConcurrency(key);
  const newCount = current - 1;

  if (newCount <= 0) {
    concurrencyTracker.delete(key);
    keyToProviderMap.delete(key);
  } else {
    concurrencyTracker.set(key, newCount);
  }

  if (requestId && localActiveRequests.has(key)) {
    localActiveRequests.get(key).delete(requestId);
    if (localActiveRequests.get(key).size === 0) {
      localActiveRequests.delete(key);
    }
  }

  const timestamp = Date.now();

  broadcastChange(
    "decrement",
    key,
    provider,
    newCount > 0 ? newCount : 0,
    current,
    requestId,
  );

  emitConcurrencyEvent({
    type: "decrement",
    key: getKeyIdentifier(key),
    provider: provider,
    current: newCount > 0 ? newCount : 0,
    previous: current,
    timestamp,
    source: "local",
  });
}

// 获取当前所有 Key 的并发状态
export function getConcurrencyStatus() {
  const status = {};
  concurrencyTracker.forEach((value, key) => {
    status[getKeyIdentifier(key)] = {
      count: value,
      provider: keyToProviderMap.get(key) || "",
    };
  });
  return status;
}

// 注册并发变化事件监听器
// @param {Function} listener - 事件监听函数，接收 { type, key, current, previous, timestamp }
// @returns {Function} unsubscribe - 取消监听的函数
export function subscribe(listener) {
  if (typeof listener !== "function") {
    throw new Error("监听器必须是一个函数");
  }

  concurrencyListeners.add(listener);

  const unsubscribe = () => {
    concurrencyListeners.delete(listener);
  };

  return unsubscribe;
}
