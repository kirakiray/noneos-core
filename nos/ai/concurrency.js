// 并发管理模块
// 负责跟踪 API Key 的并发请求数和事件监听
// 支持跨标签页状态同步

import { getLocaleText } from "/nos/locale-text/get-locale-text.js";

// 并发跟踪器：{ id => { count, provider } }
const tracker = new Map();

// 本标签页活跃请求：{ id => Set<requestId> }
const activeRequests = new Map();

// 事件监听器
const listeners = new Set();

// 跨标签页通道
const channel = new BroadcastChannel("ai-concurrency-sync");

// 是否已初始化
let initialized = false;

// 生成唯一请求 ID
const genReqId = () =>
  `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;

// 触发事件
const emit = (event) => {
  listeners.forEach((fn) => {
    try {
      fn(event);
    } catch (e) {
      console.error(
        getLocaleText({ cn: "监听器执行失败:", en: "Listener failed:" }),
        e,
      );
    }
  });
};

// 广播到其他标签页
const broadcast = (type, id, current, previous, requestId) => {
  const item = tracker.get(id);
  channel.postMessage({
    type,
    id,
    provider: item?.provider || "",
    current,
    previous,
    requestId,
    timestamp: Date.now(),
  });
};

// 获取当前并发数
export const getCount = (id) => tracker.get(id)?.count || 0;

// 增加并发，返回 requestId
export const inc = (id, provider) => {
  const item = tracker.get(id);
  const prev = item?.count || 0;
  const count = prev + 1;

  tracker.set(id, { count, provider: provider || item?.provider || "" });

  const reqId = genReqId();
  if (!activeRequests.has(id)) activeRequests.set(id, new Set());
  activeRequests.get(id).add(reqId);

  broadcast("increment", id, count, prev, reqId);
  emit({ type: "increment", id, provider, count, prev, source: "local" });

  return reqId;
};

// 减少并发
export const dec = (id, reqId) => {
  const item = tracker.get(id);
  if (!item) return;

  const prev = item.count;
  const count = prev - 1;

  if (count <= 0) {
    tracker.delete(id);
  } else {
    tracker.set(id, { count, provider: item.provider });
  }

  if (reqId && activeRequests.has(id)) {
    activeRequests.get(id).delete(reqId);
    if (activeRequests.get(id).size === 0) activeRequests.delete(id);
  }

  broadcast("decrement", id, count > 0 ? count : 0, prev, reqId);
  emit({
    type: "decrement",
    id,
    provider: item.provider,
    count: count > 0 ? count : 0,
    prev,
    source: "local",
  });
};

// 获取所有并发状态
export const getStatus = () => {
  const status = {};
  tracker.forEach(({ count, provider }, id) => {
    status[id] = { count, provider };
  });
  return status;
};

// 订阅并发变化
export const subscribe = (fn) => {
  if (typeof fn !== "function") {
    throw new Error(
      getLocaleText({
        cn: "监听器必须是函数",
        en: "Listener must be a function",
      }),
    );
  }
  listeners.add(fn);

  if (!initialized) {
    initialized = true;
    channel.postMessage({ type: "init-request", timestamp: Date.now() });
  }

  return () => listeners.delete(fn);
};

// 监听其他标签页
channel.onmessage = (event) => {
  const { type, id, provider, current, previous, timestamp, data } = event.data;

  if (type === "init-request") {
    const status = [];
    tracker.forEach(({ count, provider }, id) => {
      if (count > 0) {
        status.push({ id, provider, count });
      }
    });
    if (status.length > 0) {
      channel.postMessage({
        type: "init-response",
        data: status,
        timestamp: Date.now(),
      });
    }
    return;
  }

  if (type === "init-response") {
    data.forEach((item) => {
      const existing = tracker.get(item.id);
      if (!existing || existing.count < item.count) {
        tracker.set(item.id, { count: item.count, provider: item.provider });
        emit({
          type: "init",
          id: item.id,
          provider: item.provider,
          count: item.count,
          prev: existing?.count || 0,
          source: "remote",
        });
      }
    });
    return;
  }

  if (type === "cleanup") {
    data.forEach((item) => {
      const prev = tracker.get(item.id)?.count || 0;
      const count = prev - item.count;
      if (count <= 0) {
        tracker.delete(item.id);
      } else {
        const existing = tracker.get(item.id);
        tracker.set(item.id, {
          count,
          provider: existing?.provider || item.provider,
        });
      }
      emit({
        type: "cleanup",
        id: item.id,
        provider: item.provider,
        count: count > 0 ? count : 0,
        prev,
        source: "remote",
      });
    });
    return;
  }

  const prev = previous;
  if (type === "increment") {
    tracker.set(id, { count: current, provider });
  } else if (type === "decrement") {
    if (current <= 0) {
      tracker.delete(id);
    } else {
      tracker.set(id, { count: current, provider });
    }
  }

  emit({ type, id, provider, count: current, prev, source: "remote" });
};

// 标签页关闭时清理
window.addEventListener("beforeunload", () => {
  const cleanup = [];
  activeRequests.forEach((reqIds, id) => {
    if (reqIds.size > 0) {
      cleanup.push({
        id,
        provider: tracker.get(id)?.provider || "",
        count: reqIds.size,
      });
    }
  });
  if (cleanup.length > 0) {
    channel.postMessage({
      type: "cleanup",
      data: cleanup,
      timestamp: Date.now(),
    });
  }
});
