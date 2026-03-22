// 并发管理模块
// 负责跟踪 API Key 的并发请求数和事件监听

// 并发跟踪器：记录每个 API Key 的当前并发请求数
const concurrencyTracker = new Map();

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
export function incrementConcurrency(key) {
  const current = getCurrentConcurrency(key);
  const newCount = current + 1;
  concurrencyTracker.set(key, newCount);

  emitConcurrencyEvent({
    type: "increment",
    key: getKeyIdentifier(key),
    current: newCount,
    previous: current,
    timestamp: Date.now(),
  });
}

// 减少并发计数，计数为0时移除
export function decrementConcurrency(key) {
  const current = getCurrentConcurrency(key);
  const newCount = current - 1;

  if (newCount <= 0) {
    concurrencyTracker.delete(key);
  } else {
    concurrencyTracker.set(key, newCount);
  }

  emitConcurrencyEvent({
    type: "decrement",
    key: getKeyIdentifier(key),
    current: newCount > 0 ? newCount : 0,
    previous: current,
    timestamp: Date.now(),
  });
}

// 获取当前所有 Key 的并发状态
export function getConcurrencyStatus() {
  const status = {};
  concurrencyTracker.forEach((value, key) => {
    status[getKeyIdentifier(key)] = value;
  });
  return status;
}

// 注册并发变化事件监听器
// @param {Function} listener - 事件监听函数，接收 { type, key, current, previous, timestamp }
// @returns {Function} clear - 取消监听的函数
export function bind(listener) {
  if (typeof listener !== "function") {
    throw new Error("监听器必须是一个函数");
  }

  concurrencyListeners.add(listener);

  const clear = () => {
    concurrencyListeners.delete(listener);
  };

  return clear;
}

// 获取当前所有已注册的监听器数量
export function getConcurrencyListenerCount() {
  return concurrencyListeners.size;
}

// 移除所有并发事件监听器
export function clearConcurrencyListeners() {
  concurrencyListeners.clear();
}
