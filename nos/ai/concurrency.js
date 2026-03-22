// 并发管理模块
// 负责跟踪 API Key 的并发请求数和事件监听

// 并发跟踪器：记录每个 API Key 的当前并发请求数和 provider
const concurrencyTracker = new Map();

// Key 到 Provider 的映射
const keyToProviderMap = new Map();

// 并发事件监听器集合
const concurrencyListeners = new Set();

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

// 增加并发计数
export function incrementConcurrency(key, provider) {
  const current = getCurrentConcurrency(key);
  const newCount = current + 1;
  concurrencyTracker.set(key, newCount);
  if (provider) {
    keyToProviderMap.set(key, provider);
  }

  emitConcurrencyEvent({
    type: "increment",
    key: getKeyIdentifier(key),
    provider: provider,
    current: newCount,
    previous: current,
    timestamp: Date.now(),
  });
}

// 减少并发计数，计数为0时移除
export function decrementConcurrency(key, provider) {
  const current = getCurrentConcurrency(key);
  const newCount = current - 1;

  if (newCount <= 0) {
    concurrencyTracker.delete(key);
    keyToProviderMap.delete(key);
  } else {
    concurrencyTracker.set(key, newCount);
  }

  emitConcurrencyEvent({
    type: "decrement",
    key: getKeyIdentifier(key),
    provider: provider,
    current: newCount > 0 ? newCount : 0,
    previous: current,
    timestamp: Date.now(),
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
