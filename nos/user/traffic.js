/**
 * TrafficLogger - 客户端流量记录模块
 *
 * 记录本地用户所有出站/入站消息的元数据（不含消息内容），
 * 便于后续查询、聚合统计和清理。数据持久化在 nos_user_${namespace}
 * 数据库的 traffic_entries（明细）与 traffic_agg_minute（分钟聚合）两张表。
 *
 * 设计要点：
 * - 只记录元数据 + 大小（byteLength），不记内容
 * - 批量刷盘（默认 500ms / 50 条），页面异常关闭最多丢一次批
 * - 明细表按 ts 建索引，可按对端 / via / server / category / app 过滤
 * - 分钟聚合按 (peerUserId × via × serverUrl × category) 维度，
 *   按 appId 维度的查询走明细表 by_app_ts 索引
 * - 所有失败静默（console.warn），永远不影响业务
 */

import { getSharedDb, TRAFFIC_STORES } from "./db.js";

const ENTRIES = TRAFFIC_STORES.entries;
const AGG_MINUTE = TRAFFIC_STORES.aggMinute;
const MINUTE_MS = 60 * 1000;

/**
 * 依据消息内容推断 category
 * @param {*} data - 消息数据（可为字符串、对象、二进制帧 header 等）
 * @param {Object} [hint] - 额外提示（如 { hasAppId: true, appId: "xxx" }）
 * @returns {{ category: string, messageType: string, appId: string }}
 */
export function inferCategory(data, hint = {}) {
  const appIdHint = hint.appId || "";
  const hasAppId = hint.hasAppId || (data && typeof data === "object" && data.__app);

  if (hasAppId) {
    const appId = appIdHint || (data && typeof data === "object" ? data.__app : "") || "";
    return { category: "app", messageType: "__app", appId };
  }

  if (!data || typeof data !== "object") {
    return { category: "other", messageType: "", appId: "" };
  }

  const type = data.type || "";

  if (type === "__service_query" || type === "__service_response") {
    return { category: "service", messageType: type, appId: "" };
  }
  if (type === "card") {
    return { category: "card", messageType: "card", appId: "" };
  }
  if (type === "rtc_signal") {
    return { category: "rtc_signal", messageType: "rtc_signal", appId: "" };
  }
  if (
    type === "__ping__" ||
    type === "__pong__" ||
    type === "latency_test" ||
    type === "latency_test_response" ||
    type === "latency_report" ||
    type === "latency_report_ack"
  ) {
    return { category: "latency", messageType: type, appId: "" };
  }
  if (
    type === "handshake_challenge" ||
    type === "handshake" ||
    type === "handshake_response"
  ) {
    return { category: "handshake", messageType: type, appId: "" };
  }
  if (type === "update_services") {
    return { category: "control", messageType: type, appId: "" };
  }
  if (type === "relay") {
    return { category: "relay", messageType: "relay", appId: "" };
  }
  if (type) {
    return { category: "other", messageType: type, appId: "" };
  }
  return { category: "other", messageType: "", appId: "" };
}

/**
 * 测量任意可发送数据的字节数（TextEncoder / ArrayBuffer / Blob）
 * @param {*} data
 * @returns {number}
 */
export function measureSize(data) {
  if (data == null) return 0;
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength;
  }
  if (data instanceof ArrayBuffer) return data.byteLength;
  if (ArrayBuffer.isView(data)) return data.byteLength;
  if (typeof Blob !== "undefined" && data instanceof Blob) return data.size;
  // 兜底：序列化后测量（用于纯对象）
  try {
    return new TextEncoder().encode(JSON.stringify(data)).byteLength;
  } catch {
    return 0;
  }
}

/**
 * TrafficLogger - 挂载在 LocalUser 上，负责流量记录与查询
 */
export class TrafficLogger {
  #namespace;
  #enabled = true;
  #queue = [];
  #flushTimer = null;
  #flushingPromise = null;
  #config = {
    flushIntervalMs: 500,
    flushBatchSize: 50,
    minSize: 0,
    recordCategories: null, // null 表示全部记录；数组则只记录列出的
  };

  /**
   * @param {import("./user.js").LocalUser} user - 本地用户实例
   */
  constructor(user) {
    this.#namespace = user.namespace;
  }

  get enabled() {
    return this.#enabled;
  }

  /**
   * 开启/关闭埋点记录（不影响已有数据）
   * @param {boolean} value
   */
  setEnabled(value) {
    this.#enabled = !!value;
  }

  /**
   * 更新配置项
   * @param {Object} options
   * @param {number} [options.flushIntervalMs]
   * @param {number} [options.flushBatchSize]
   * @param {number} [options.minSize]
   * @param {string[] | null} [options.recordCategories]
   */
  configure(options = {}) {
    this.#config = { ...this.#config, ...options };
  }

  /**
   * 记录一条流量事件（同步入队，异步落库）
   *
   * @param {Object} entry
   * @param {"out"|"in"} entry.direction
   * @param {"rtc"|"server"|""} entry.via
   * @param {string} [entry.peerUserId=""]
   * @param {string} [entry.sessionId=""]
   * @param {string} [entry.serverUrl=""]
   * @param {number} entry.size
   * @param {string} [entry.category="other"]
   * @param {string} [entry.messageType=""]
   * @param {string} [entry.appId=""]
   * @param {boolean} [entry.success=true]
   * @param {string} [entry.errorCode=""]
   * @param {number} [entry.ts=Date.now()]
   */
  record(entry) {
    if (!this.#enabled) return;
    if (!entry || typeof entry !== "object") return;

    const size = Number(entry.size) || 0;
    if (size < (this.#config.minSize || 0) && size !== 0) return;

    const category = entry.category || "other";
    if (
      this.#config.recordCategories &&
      !this.#config.recordCategories.includes(category)
    ) {
      return;
    }

    const record = {
      ts: entry.ts || Date.now(),
      direction: entry.direction === "in" ? "in" : "out",
      peerUserId: entry.peerUserId || "",
      sessionId: entry.sessionId || "",
      via: entry.via || "",
      serverUrl: entry.serverUrl || "",
      size,
      category,
      messageType: entry.messageType || "",
      appId: entry.appId || "",
      success: entry.success === false ? 0 : 1,
      errorCode: entry.errorCode || "",
    };

    this.#queue.push(record);

    if (this.#queue.length >= this.#config.flushBatchSize) {
      this.#scheduleFlush(0);
    } else {
      this.#scheduleFlush(this.#config.flushIntervalMs);
    }
  }

  /**
   * 手动触发一次刷盘（等待队列写完）
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    await this.#doFlush();
  }

  #scheduleFlush(delay) {
    if (this.#flushTimer) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#doFlush().catch((err) => {
        console.warn("[TrafficLogger] flush failed:", err);
      });
    }, delay);
  }

  async #doFlush() {
    if (this.#flushingPromise) {
      await this.#flushingPromise;
      return;
    }
    if (this.#queue.length === 0) return;
    const batch = this.#queue.splice(0, this.#queue.length);
    this.#flushingPromise = this.#writeBatch(batch)
      .catch((err) => {
        console.warn("[TrafficLogger] writeBatch failed:", err);
      })
      .finally(() => {
        this.#flushingPromise = null;
      });
    await this.#flushingPromise;
  }

  async #writeBatch(batch) {
    const db = await getSharedDb(this.#namespace);
    console.log(
      `[nos-debug] traffic writeBatch start: ${this.#namespace} (n=${batch.length})`,
    );
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ENTRIES, AGG_MINUTE], "readwrite");
      const entriesStore = tx.objectStore(ENTRIES);
      const aggStore = tx.objectStore(AGG_MINUTE);

      // 聚合桶：peerUserId | via | serverUrl | category
      const aggMap = new Map();

      for (const rec of batch) {
        entriesStore.add(rec);

        const bucket = Math.floor(rec.ts / MINUTE_MS) * MINUTE_MS;
        const aggId = `${bucket}|${rec.peerUserId}|${rec.via}|${rec.serverUrl}|${rec.category}`;
        let acc = aggMap.get(aggId);
        if (!acc) {
          acc = {
            id: aggId,
            bucket,
            peerUserId: rec.peerUserId,
            via: rec.via,
            serverUrl: rec.serverUrl,
            category: rec.category,
            countOut: 0,
            bytesOut: 0,
            countIn: 0,
            bytesIn: 0,
            countFail: 0,
          };
          aggMap.set(aggId, acc);
        }
        if (rec.direction === "out") {
          acc.countOut++;
          acc.bytesOut += rec.size;
        } else {
          acc.countIn++;
          acc.bytesIn += rec.size;
        }
        if (!rec.success) acc.countFail++;
      }

      // 对每个 bucket 做 get→merge→put
      let pending = aggMap.size;
      if (pending === 0) {
        tx.oncomplete = () => {
          console.log(`[nos-debug] traffic writeBatch done (empty): ${this.#namespace}`);
          resolve();
        };
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
        return;
      }

      for (const acc of aggMap.values()) {
        const req = aggStore.get(acc.id);
        req.onsuccess = () => {
          const existing = req.result;
          if (existing) {
            existing.countOut += acc.countOut;
            existing.bytesOut += acc.bytesOut;
            existing.countIn += acc.countIn;
            existing.bytesIn += acc.bytesIn;
            existing.countFail += acc.countFail;
            existing.updatedAt = Date.now();
            aggStore.put(existing);
          } else {
            acc.updatedAt = Date.now();
            aggStore.put(acc);
          }
          pending--;
        };
        req.onerror = () => {
          pending--;
        };
      }

      tx.oncomplete = () => {
        console.log(`[nos-debug] traffic writeBatch done: ${this.#namespace}`);
        resolve();
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // ───── 查询 API ─────

  /**
   * 查询明细记录（可组合过滤条件）
   *
   * @param {Object} [filter]
   * @param {number} [filter.fromTs]
   * @param {number} [filter.toTs]
   * @param {string} [filter.peerUserId]
   * @param {string} [filter.sessionId]
   * @param {"rtc"|"server"} [filter.via]
   * @param {string} [filter.serverUrl]
   * @param {string} [filter.category]
   * @param {string} [filter.messageType]
   * @param {string} [filter.appId]
   * @param {"out"|"in"} [filter.direction]
   * @param {boolean} [filter.success]
   * @param {number} [filter.limit=100]
   * @param {number} [filter.offset=0]
   * @param {"asc"|"desc"} [filter.order="desc"]
   * @returns {Promise<Array<Object>>}
   */
  async query(filter = {}) {
    await this.flush();
    const results = [];
    const {
      limit = 100,
      offset = 0,
      order = "desc",
    } = filter;

    // 挑选最佳索引
    const { indexName, range, extraFilters } = this.#pickIndex(filter);
    const db = await getSharedDb(this.#namespace);

    return new Promise((resolve, reject) => {
      const tx = db.transaction([ENTRIES], "readonly");
      const store = tx.objectStore(ENTRIES);
      const source = indexName ? store.index(indexName) : store;
      const direction = order === "asc" ? "next" : "prev";
      const req = source.openCursor(range, direction);

      let skipped = 0;
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(results);
          return;
        }
        const value = cursor.value;
        if (this.#matchesFilters(value, extraFilters)) {
          if (skipped < offset) {
            skipped++;
          } else if (results.length < limit) {
            results.push(value);
          } else {
            resolve(results);
            return;
          }
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
      tx.onerror = () => reject(tx.error);
    });
  }

  #pickIndex(filter) {
    const extras = { ...filter };
    delete extras.limit;
    delete extras.offset;
    delete extras.order;

    const fromTs = filter.fromTs;
    const toTs = filter.toTs;

    // 精确单值 + 时间范围，走对应复合索引
    const tryCompound = (key, indexName) => {
      const val = filter[key];
      if (val === undefined || val === null || val === "") return null;
      const lower = [val, fromTs ?? -Infinity];
      const upper = [val, toTs ?? Infinity];
      delete extras[key];
      return {
        indexName,
        range: IDBKeyRange.bound(lower, upper),
        extraFilters: extras,
      };
    };

    let picked =
      tryCompound("peerUserId", "peer_ts") ||
      tryCompound("appId", "app_ts") ||
      tryCompound("serverUrl", "server_ts") ||
      tryCompound("category", "cat_ts") ||
      tryCompound("via", "via_ts") ||
      tryCompound("direction", "dir_ts");

    if (picked) return picked;

    // 只有时间范围
    if (fromTs !== undefined || toTs !== undefined) {
      const lower = fromTs ?? -Infinity;
      const upper = toTs ?? Infinity;
      return {
        indexName: "ts",
        range: IDBKeyRange.bound(lower, upper),
        extraFilters: extras,
      };
    }

    // 无索引，全表扫
    return { indexName: null, range: null, extraFilters: extras };
  }

  #matchesFilters(value, filter) {
    if (!filter) return true;
    for (const key of [
      "peerUserId",
      "sessionId",
      "via",
      "serverUrl",
      "category",
      "messageType",
      "appId",
      "direction",
    ]) {
      const expected = filter[key];
      if (expected !== undefined && expected !== null && expected !== "") {
        if (value[key] !== expected) return false;
      }
    }
    if (filter.success !== undefined) {
      const expected = filter.success ? 1 : 0;
      if (value.success !== expected) return false;
    }
    if (filter.fromTs !== undefined && value.ts < filter.fromTs) return false;
    if (filter.toTs !== undefined && value.ts > filter.toTs) return false;
    return true;
  }

  /**
   * 分组聚合查询
   *
   * @param {Object} options
   * @param {number} [options.fromTs]
   * @param {number} [options.toTs]
   * @param {Array<"peer"|"via"|"server"|"category"|"minute"|"hour"|"day"|"app"|"direction">} [options.groupBy]
   * @param {string} [options.peerUserId]
   * @param {"rtc"|"server"} [options.via]
   * @param {string} [options.serverUrl]
   * @param {string} [options.category]
   * @param {string} [options.appId]
   * @returns {Promise<Array<{key: Object, countOut: number, bytesOut: number, countIn: number, bytesIn: number, countFail: number}>>}
   */
  async summary(options = {}) {
    await this.flush();
    const groupBy = options.groupBy || [];
    const useEntries = groupBy.includes("app") || options.appId;

    if (useEntries) {
      return this.#summaryFromEntries(options);
    }
    return this.#summaryFromAgg(options);
  }

  async #summaryFromAgg(options) {
    const db = await getSharedDb(this.#namespace);
    const groupBy = options.groupBy || [];
    const fromBucket =
      options.fromTs !== undefined
        ? Math.floor(options.fromTs / MINUTE_MS) * MINUTE_MS
        : -Infinity;
    const toBucket =
      options.toTs !== undefined
        ? Math.floor(options.toTs / MINUTE_MS) * MINUTE_MS
        : Infinity;

    const range = IDBKeyRange.bound(fromBucket, toBucket);
    const rows = await new Promise((resolve, reject) => {
      const tx = db.transaction([AGG_MINUTE], "readonly");
      const store = tx.objectStore(AGG_MINUTE);
      const req = store.index("bucket").openCursor(range);
      const out = [];
      req.onsuccess = () => {
        const cursor = req.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        const value = cursor.value;
        if (this.#aggMatchesFilter(value, options)) {
          out.push(value);
        }
        cursor.continue();
      };
      req.onerror = () => reject(req.error);
    });

    return this.#groupRows(rows, groupBy);
  }

  #aggMatchesFilter(row, options) {
    if (options.peerUserId && row.peerUserId !== options.peerUserId) return false;
    if (options.via && row.via !== options.via) return false;
    if (options.serverUrl && row.serverUrl !== options.serverUrl) return false;
    if (options.category && row.category !== options.category) return false;
    return true;
  }

  async #summaryFromEntries(options) {
    const groupBy = options.groupBy || [];
    const rows = await this.query({
      fromTs: options.fromTs,
      toTs: options.toTs,
      peerUserId: options.peerUserId,
      via: options.via,
      serverUrl: options.serverUrl,
      category: options.category,
      appId: options.appId,
      limit: Number.MAX_SAFE_INTEGER,
      order: "asc",
    });
    // 将明细转成聚合行结构
    const converted = rows.map((r) => ({
      bucket: Math.floor(r.ts / MINUTE_MS) * MINUTE_MS,
      peerUserId: r.peerUserId,
      via: r.via,
      serverUrl: r.serverUrl,
      category: r.category,
      appId: r.appId,
      countOut: r.direction === "out" ? 1 : 0,
      bytesOut: r.direction === "out" ? r.size : 0,
      countIn: r.direction === "in" ? 1 : 0,
      bytesIn: r.direction === "in" ? r.size : 0,
      countFail: r.success ? 0 : 1,
    }));
    return this.#groupRows(converted, groupBy);
  }

  #groupRows(rows, groupBy) {
    const groups = new Map();
    for (const row of rows) {
      const key = {};
      for (const dim of groupBy) {
        switch (dim) {
          case "peer":
            key.peerUserId = row.peerUserId;
            break;
          case "via":
            key.via = row.via;
            break;
          case "server":
            key.serverUrl = row.serverUrl;
            break;
          case "category":
            key.category = row.category;
            break;
          case "app":
            key.appId = row.appId || "";
            break;
          case "minute":
            key.bucket = row.bucket;
            break;
          case "hour":
            key.bucket = Math.floor(row.bucket / (60 * MINUTE_MS)) * (60 * MINUTE_MS);
            break;
          case "day":
            key.bucket = Math.floor(row.bucket / (1440 * MINUTE_MS)) * (1440 * MINUTE_MS);
            break;
          case "direction":
            key.direction =
              row.countOut > 0 && row.countIn === 0
                ? "out"
                : row.countIn > 0 && row.countOut === 0
                ? "in"
                : "mixed";
            break;
          default:
            break;
        }
      }
      const keyStr = JSON.stringify(key);
      let acc = groups.get(keyStr);
      if (!acc) {
        acc = {
          key,
          countOut: 0,
          bytesOut: 0,
          countIn: 0,
          bytesIn: 0,
          countFail: 0,
        };
        groups.set(keyStr, acc);
      }
      acc.countOut += row.countOut || 0;
      acc.bytesOut += row.bytesOut || 0;
      acc.countIn += row.countIn || 0;
      acc.bytesIn += row.bytesIn || 0;
      acc.countFail += row.countFail || 0;
    }
    return [...groups.values()];
  }

  // ───── 便捷聚合方法 ─────

  async getPeerTotals(range = {}) {
    return this.summary({ ...range, groupBy: ["peer"] });
  }

  async getServerTotals(range = {}) {
    return this.summary({ ...range, groupBy: ["server"] });
  }

  async getTimeline(options = {}) {
    const { groupBy = "minute", ...range } = options;
    return this.summary({ ...range, groupBy: [groupBy] });
  }

  async getTotalStats(range = {}) {
    const [total] = await this.summary({ ...range, groupBy: [] });
    return (
      total || {
        key: {},
        countOut: 0,
        bytesOut: 0,
        countIn: 0,
        bytesIn: 0,
        countFail: 0,
      }
    );
  }

  // ───── 元数据 ─────

  /**
   * 快速计数（支持部分过滤条件）
   * @param {Object} [filter]
   * @returns {Promise<number>}
   */
  async count(filter = {}) {
    await this.flush();
    const db = await getSharedDb(this.#namespace);
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ENTRIES], "readonly");
      const store = tx.objectStore(ENTRIES);

      const hasFilter = Object.keys(filter).some(
        (k) => filter[k] !== undefined && filter[k] !== null && filter[k] !== "",
      );
      if (!hasFilter) {
        const req = store.count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        return;
      }

      // 有过滤条件，走 query 计数
      this.query({ ...filter, limit: Number.MAX_SAFE_INTEGER })
        .then((rows) => resolve(rows.length))
        .catch(reject);
    });
  }

  /**
   * 获取存储元信息
   * @returns {Promise<{entryCount: number, aggCount: number, oldestTs: number|null, newestTs: number|null}>}
   */
  async getStorageInfo() {
    await this.flush();
    const db = await getSharedDb(this.#namespace);
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ENTRIES, AGG_MINUTE], "readonly");
      const entriesStore = tx.objectStore(ENTRIES);
      const aggStore = tx.objectStore(AGG_MINUTE);

      let entryCount = 0;
      let aggCount = 0;
      let oldestTs = null;
      let newestTs = null;

      entriesStore.count().onsuccess = (e) => {
        entryCount = e.target.result;
      };
      aggStore.count().onsuccess = (e) => {
        aggCount = e.target.result;
      };

      // 最早/最晚：通过 ts 索引获取首尾
      const tsIndex = entriesStore.index("ts");
      tsIndex.openCursor(null, "next").onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) oldestTs = cursor.value.ts;
      };
      tsIndex.openCursor(null, "prev").onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) newestTs = cursor.value.ts;
      };

      tx.oncomplete = () =>
        resolve({ entryCount, aggCount, oldestTs, newestTs });
      tx.onerror = () => reject(tx.error);
    });
  }

  // ───── 删除 API ─────

  /**
   * 删除指定时间之前的所有记录（明细 + 聚合桶）
   * @param {number} ts - 毫秒时间戳
   * @returns {Promise<{entriesDeleted: number, aggsDeleted: number}>}
   */
  async deleteBefore(ts) {
    await this.flush();
    const db = await getSharedDb(this.#namespace);
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ENTRIES, AGG_MINUTE], "readwrite");
      const entriesStore = tx.objectStore(ENTRIES);
      const aggStore = tx.objectStore(AGG_MINUTE);

      let entriesDeleted = 0;
      let aggsDeleted = 0;

      // 删 entries：ts < ts
      const tsIndex = entriesStore.index("ts");
      const eReq = tsIndex.openCursor(IDBKeyRange.upperBound(ts, true));
      eReq.onsuccess = () => {
        const cursor = eReq.result;
        if (cursor) {
          cursor.delete();
          entriesDeleted++;
          cursor.continue();
        }
      };

      // 删 agg_minute：bucket 上限 = 分钟对齐
      const bucketLimit = Math.floor(ts / MINUTE_MS) * MINUTE_MS;
      const bucketIdx = aggStore.index("bucket");
      const aReq = bucketIdx.openCursor(IDBKeyRange.upperBound(bucketLimit, true));
      aReq.onsuccess = () => {
        const cursor = aReq.result;
        if (cursor) {
          cursor.delete();
          aggsDeleted++;
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve({ entriesDeleted, aggsDeleted });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * 按条件删除记录
   *
   * @param {Object} filter
   * @param {number} [filter.toTs] - 删除此时间戳之前的记录
   * @param {string} [filter.peerUserId]
   * @param {string} [filter.category]
   * @returns {Promise<{entriesDeleted: number, aggsDeleted: number}>}
   */
  async delete(filter = {}) {
    await this.flush();
    const hasCondition =
      filter.peerUserId || filter.category || filter.via || filter.serverUrl;

    if (!hasCondition && filter.toTs !== undefined) {
      return this.deleteBefore(filter.toTs);
    }

    const db = await getSharedDb(this.#namespace);
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ENTRIES, AGG_MINUTE], "readwrite");
      const entriesStore = tx.objectStore(ENTRIES);
      const aggStore = tx.objectStore(AGG_MINUTE);

      let entriesDeleted = 0;
      let aggsDeleted = 0;
      const toTs = filter.toTs;

      const matchEntry = (v) => {
        if (filter.peerUserId && v.peerUserId !== filter.peerUserId) return false;
        if (filter.category && v.category !== filter.category) return false;
        if (filter.via && v.via !== filter.via) return false;
        if (filter.serverUrl && v.serverUrl !== filter.serverUrl) return false;
        if (toTs !== undefined && v.ts > toTs) return false;
        return true;
      };
      const matchAgg = (v) => {
        if (filter.peerUserId && v.peerUserId !== filter.peerUserId) return false;
        if (filter.category && v.category !== filter.category) return false;
        if (filter.via && v.via !== filter.via) return false;
        if (filter.serverUrl && v.serverUrl !== filter.serverUrl) return false;
        if (toTs !== undefined) {
          const bucketLimit = Math.floor(toTs / MINUTE_MS) * MINUTE_MS;
          if (v.bucket > bucketLimit) return false;
        }
        return true;
      };

      const eReq = entriesStore.openCursor();
      eReq.onsuccess = () => {
        const cursor = eReq.result;
        if (cursor) {
          if (matchEntry(cursor.value)) {
            cursor.delete();
            entriesDeleted++;
          }
          cursor.continue();
        }
      };

      const aReq = aggStore.openCursor();
      aReq.onsuccess = () => {
        const cursor = aReq.result;
        if (cursor) {
          if (matchAgg(cursor.value)) {
            cursor.delete();
            aggsDeleted++;
          }
          cursor.continue();
        }
      };

      tx.oncomplete = () => resolve({ entriesDeleted, aggsDeleted });
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * 清空所有流量数据
   * @returns {Promise<void>}
   */
  async clearAll() {
    // 丢弃未刷盘队列
    this.#queue = [];
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const db = await getSharedDb(this.#namespace);
    return new Promise((resolve, reject) => {
      const tx = db.transaction([ENTRIES, AGG_MINUTE], "readwrite");
      tx.objectStore(ENTRIES).clear();
      tx.objectStore(AGG_MINUTE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }
}
