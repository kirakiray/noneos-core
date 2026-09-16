/**
 * 可靠投递核心原语
 *
 * 与 remote-user.js / user.js 配合，为 sendToService 提供：
 * - 消息信封（msgId/seq）：核心层去重与 ACK 的唯一凭据
 * - DedupCache：接收端按 (fromUserId|msgId) 去重，发送方重发不会重复执行 handler
 * - AckWaiter：发送端按 msgId 挂起等待对端核心层 ACK，带超时
 *
 * 兼容性：未携带 __env 信封的消息（旧版对端发出）不参与去重与 ACK，
 * 行为与旧版本完全一致；新旧版本混跑时自动退化为尽力投递语义。
 */

let msgSeq = 0;

/**
 * 生成消息唯一 ID（同标签页内单调，随机后缀防碰撞）
 * @returns {string}
 */
export function createMsgId() {
  return `m_${Date.now().toString(36)}_${(++msgSeq).toString(36)}_${Math.random()
    .toString(36)
    .substring(2, 8)}`;
}

/**
 * 接收端去重缓存（带 LRU 淘汰）
 *
 * check(key) 首次见到返回 true 并记录，重复出现刷新位置并返回 false。
 * 容量超限时淘汰最旧的记录。
 */
export class DedupCache {
  #max;
  #map = new Map(); // key -> 记录时间（仅用于调试观测）

  /**
   * @param {number} [max=4096] 最大缓存条数
   */
  constructor(max = 4096) {
    this.#max = Math.max(1, max);
  }

  /**
   * 检查 key 是否首次出现
   * @param {string} key
   * @returns {boolean} true = 首次出现（应执行处理）；false = 重复（应跳过）
   */
  check(key) {
    if (this.#map.has(key)) {
      // 刷新 LRU 位置
      const seenAt = this.#map.get(key);
      this.#map.delete(key);
      this.#map.set(key, seenAt);
      return false;
    }
    this.#map.set(key, Date.now());
    if (this.#map.size > this.#max) {
      const oldest = this.#map.keys().next().value;
      this.#map.delete(oldest);
    }
    return true;
  }

  get size() {
    return this.#map.size;
  }

  clear() {
    this.#map.clear();
  }
}

/**
 * 发送端 ACK 等待器
 *
 * wait(msgId, timeout) 挂起等待；对端 ACK 到达时经 resolve(msgId, payload)
 * 结算为 { confirmed: true, ...payload }；超时结算为 { confirmed: false, reason: "timeout" }。
 *
 * 竞态缓冲：ACK 可能先于 wait() 到达（如对端回执极快，发送端还在给其他
 * session 投递），此时结算内容暂存 #recent，随后的 wait() 立即命中返回。
 */
export class AckWaiter {
  #pending = new Map(); // msgId -> { resolve, timer }
  #recent = new Map(); // msgId -> payload（先到未认领的 ACK）
  #RECENT_MAX = 256;

  /**
   * 等待某条消息的 ACK
   * @param {string} msgId
   * @param {number} timeoutMs 超时（毫秒）
   * @returns {Promise<{confirmed: boolean, reason?: string, duplicate?: boolean, error?: string}>}
   */
  wait(msgId, timeoutMs) {
    // ACK 已先到达：立即结算
    const recent = this.#recent.get(msgId);
    if (recent) {
      this.#recent.delete(msgId);
      return Promise.resolve(recent);
    }
    return new Promise((resolve) => {
      const entry = {
        resolve,
        timer: setTimeout(() => {
          this.#pending.delete(msgId);
          resolve({ confirmed: false, reason: "timeout" });
        }, timeoutMs),
      };
      this.#pending.set(msgId, entry);
    });
  }

  /**
   * 结算某条消息的 ACK 成功；无挂起等待时暂存进先到缓冲并返回 false
   * @param {string} msgId
   * @param {Object} [payload]
   * @returns {boolean} 是否结算了挂起中的等待
   */
  resolve(msgId, payload = {}) {
    return this.#settle(msgId, { confirmed: true, ...payload });
  }

  /**
   * 结算确定性失败（对端回 ok:false：no_handler / handler_error 等）：
   * 结算为 { confirmed: false, reason }，发送方据此立即失败而不重发。
   * @param {string} msgId
   * @param {string} reason
   * @returns {boolean}
   */
  resolveFailure(msgId, reason, message) {
    const result = { confirmed: false, reason };
    if (message) result.message = String(message).slice(0, 300);
    return this.#settle(msgId, result);
  }

  /**
   * 内部统一结算：优先结算挂起等待，否则进入先到缓冲
   */
  #settle(msgId, result) {
    const entry = this.#pending.get(msgId);
    if (entry) {
      clearTimeout(entry.timer);
      this.#pending.delete(msgId);
      entry.resolve(result);
      return true;
    }
    this.#recent.set(msgId, result);
    if (this.#recent.size > this.#RECENT_MAX) {
      const oldest = this.#recent.keys().next().value;
      this.#recent.delete(oldest);
    }
    return false;
  }

  get pendingCount() {
    return this.#pending.size;
  }

  /** 清空所有挂起等待与先到缓冲（dispose 时调用） */
  clear() {
    for (const { timer } of this.#pending.values()) {
      clearTimeout(timer);
    }
    this.#pending.clear();
    this.#recent.clear();
  }
}
