import { BaseUser } from "./base-user.js";
import { tryEncryptBinary } from "../crypto/crypto-e2ee.js";
import { inferCategory, measureSize } from "./traffic.js";

/**
 * 远程用户类，代表通过服务器连接的另一个用户
 * 提供查询对方在线状态、发送数据、接收消息的能力
 *
 * 内置用户间 ping/pong 机制，按 sessionId 粒度跟踪 RTT。
 * send() 时会检测路径变化（server → rtc 或 rtc → server），
 * 自动触发一次 ping 以重新计算 RTT。
 */
export class RemoteUser extends BaseUser {
  #userId;
  #localUser;
  #sendCounts = new Map(); // sessionId -> 已发送次数
  #rtcInitiated = new Set(); // 已触发后台 RTC 连接的 sessionId
  #rttMap = new Map(); // sessionId -> { rtt, via, url, timestamp }
  #pendingPings = new Map(); // pingId -> { sessionId, resolve, reject, timeoutId }
  #lastSendVia = new Map(); // sessionId -> { via: 'rtc'|'server', url?: string }
  #pingSeq = 0;
  // sessionId -> 冷却截止时间戳；RTC 断开后此期间内不重新发起 connect，
  // 防止网络抖动 / 对端频繁刷新时 PC 反复重建造成风暴。
  #rtcCooldownUntil = new Map();
  #RECONNECT_COOLDOWN_MS = 5000;
  // appId -> { sessions: string[], timestamp: number }
  // 缓存对端各 appId 对应的 sessionId 列表，供 sendToService 精准投递
  #serviceSessionCache = new Map();
  // 服务发现缓存的 TTL（毫秒）；对端 __service_available/unavailable 会即时刷新
  #SERVICE_CACHE_TTL = 30000;
  // appId -> Set<{ resolve, remainingUntil }> 等待服务上线的挂起 promise
  #serviceWaiters = new Map();
  // 共享存储只读代理缓存：name -> proxy。
  // userId 维度由 RemoteUser 实例本身隔离，Map 内只需按 name 区分。
  #storageProxies = new Map();
  // reqId -> { resolve, reject, timeoutId } 等待 __storage_resp 的挂起请求
  #pendingStorageReqs = new Map();
  #storageReqSeq = 0;
  // 单次共享存储请求的默认超时（毫秒）
  #STORAGE_REQ_TIMEOUT = 10000;

  /**
   * @param {string} userId - 目标用户的 userId
   * @param {import("./user.js").LocalUser} localUser - 本地用户实例
   */
  constructor(userId, localUser) {
    super();
    if (!userId) {
      throw new Error("userId is required");
    }
    this.#userId = userId;
    this.#localUser = localUser;
    this.#setupPingListener();
  }

  /**
   * 获取远程用户的 ID
   */
  get userId() {
    return this.#userId;
  }

  /**
   * 获取远程用户当前的 sessionId 列表
   * 通过查询所有已连接的服务器获取
   * @returns {Promise<string[]>}
   */
  async getSessionIds() {
    const server = this.#localUser.server;
    const urls = server.connectedUrls;
    const allSessions = new Set();

    for (const url of urls) {
      try {
        const result = await server.queryUserOnline(url, this.#userId);
        if (result.online && Array.isArray(result.sessions)) {
          for (const s of result.sessions) {
            allSessions.add(s);
          }
        }
      } catch {
        // 查询失败的服务器跳过
      }
    }

    return [...allSessions];
  }

  // ───── 远端共享存储（只读） ─────

  /**
   * 获取远端用户已共享存储空间的只读代理。
   *
   * 仅可访问对端通过 `shareStorage("share:xxx")` 显式开启的空间；
   * name 必须以 `share:` 开头，否则直接抛错（请求端预校验）。
   *
   * 代理可用操作（均返回 Promise）：
   * - `getItem(key)` / `has(key)` / `key(index)`
   * - `length`（getter，`await proxy.length`）
   * - `keys()` / `entries()`（返回数组；与本地异步生成器不同，远端一次性回传）
   * - `setItem` / `removeItem` / `clear` 调用即抛错（远端共享只读）
   *
   * 同一 `(userId, name)` 的代理实例会被缓存复用。
   * 请求失败抛出的 Error 带有 `code` 属性：
   * `offline`（对端离线，不重试）/ `timeout`（超时，含自动重发后仍失败）/
   * `invalid_name` / `not_shared` / `read_only` / `too_large` / `internal`（对端回传，不重试）。
   *
   * @param {string} name - 存储空间名，必须以 "share:" 开头
   * @param {Object} [options]
   * @param {number} [options.timeout=10000] 单次尝试超时（毫秒）
   * @param {number} [options.retries=1] 超时/发送失败的自动重发次数（只读幂等操作，重发安全）
   * @returns {Promise<Object>} 只读代理对象
   */
  async getStorage(name, options = {}) {
    if (typeof name !== "string" || !name.startsWith("share:")) {
      throw new Error('shared storage name must start with "share:"');
    }
    if (this.#storageProxies.has(name)) {
      return this.#storageProxies.get(name);
    }

    const timeout =
      typeof options?.timeout === "number" && options.timeout > 0
        ? options.timeout
        : this.#STORAGE_REQ_TIMEOUT;
    const retries =
      typeof options?.retries === "number" && options.retries >= 0
        ? Math.floor(options.retries)
        : 1;
    const request = (op, key) =>
      this.#requestStorage(name, op, key, timeout, retries);

    const proxy = {
      userId: this.#userId,
      name,
      getItem: (key) => request("getItem", key),
      has: (key) => request("has", key),
      key: (index) => request("key", index),
      get length() {
        return request("length");
      },
      keys: () => request("keys"),
      entries: () => request("entries"),
      setItem() {
        throw new Error("shared storage is read-only: setItem is not allowed");
      },
      removeItem() {
        throw new Error("shared storage is read-only: removeItem is not allowed");
      },
      clear() {
        throw new Error("shared storage is read-only: clear is not allowed");
      },
    };

    this.#storageProxies.set(name, proxy);
    return proxy;
  }

  /**
   * 发送 __storage_req 并等待对应的 __storage_resp，带自动重发。
   *
   * 重发策略：只读操作幂等，重发安全。仅对**瞬时失败**重发——
   * 超时（timeout）与通道发送失败（无 code 的异常）；
   * 对端明确回传的错误（not_shared / read_only / too_large 等）是确定性
   * 失败，重发只会浪费时间，立即抛出。
   * 对端离线（offline）同样是确定状态，直接抛出不重试。
   * 每次尝试使用新的 reqId，配对互不干扰。
   */
  async #requestStorage(name, op, key, timeout, retries) {
    const maxAttempts = 1 + Math.max(0, retries);
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      // 每次尝试前重查在线状态：会话可能在中途恢复或消失
      const sessionIds = await this.getSessionIds();
      if (sessionIds.length === 0) {
        const err = new Error(
          `storage request failed: user ${this.#userId} is offline`,
        );
        err.code = "offline";
        throw err;
      }

      try {
        return await this.#sendStorageRequest(
          sessionIds[0],
          name,
          op,
          key,
          timeout,
        );
      } catch (err) {
        const transient = err.code === "timeout" || !err.code;
        if (!transient || attempt >= maxAttempts) {
          throw err;
        }
        // 瞬时失败且还有重试额度：立即重发
      }
    }
  }

  /** 单次尝试：发一条 __storage_req，按 reqId 挂起等待响应 */
  #sendStorageRequest(sessionId, name, op, key, timeout) {
    const reqId = `sr_${++this.#storageReqSeq}_${Date.now()}`;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.#pendingStorageReqs.delete(reqId);
        const err = new Error(
          `storage request timeout: ${op} "${name}" (${timeout}ms)`,
        );
        err.code = "timeout";
        reject(err);
      }, timeout);

      this.#pendingStorageReqs.set(reqId, { resolve, reject, timeoutId });

      this.#sendRaw(sessionId, { type: "__storage_req", reqId, name, op, key })
        .catch((err) => {
          clearTimeout(timeoutId);
          this.#pendingStorageReqs.delete(reqId);
          reject(err);
        });
    });
  }

  /**
   * 收到 __storage_resp：按 reqId 结算挂起请求。
   * ok 时 resolve(value)；失败时 reject（Error 带 code 属性）。
   */
  #handleStorageResponse(parsed) {
    const pending = this.#pendingStorageReqs.get(parsed.reqId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this.#pendingStorageReqs.delete(parsed.reqId);

    if (parsed.ok) {
      pending.resolve(parsed.value);
    } else {
      const code = parsed.error?.code || "unknown";
      const err = new Error(
        parsed.error?.message || `storage request failed (${code})`,
      );
      err.code = code;
      pending.reject(err);
    }
  }

  /**
   * 发送数据给对方
   *
   * 默认启用 E2EE 加密：如果双方已完成名片交换，
   * 数据会用 ECDH 派生密钥 + AES-GCM 加密后传输，
   * 密文走二进制帧通道，服务端无法窥探明文内容。
   *
   * 内部使用 `raw=true` 绕过加密（如名片协议自身的交换过程）。
   *
   * 优先尝试 RTC 直连：若与目标 session 的 DataChannel 已就绪，
   * 直接通过 WebRTC 发送；否则后台静默发起 RTC 配对，
   * 本次及配对完成前继续走服务器中转兜底。
   *
   * 每次发送后会检测传输路径是否变化（server ↔ rtc），
   * 路径变化时自动触发一次 ping 以重新计算 RTT。
   *
   * @param {string} sessionId - 目标会话 ID
   * @param {*} data - 要发送的数据（JSON 可序列化值）
   * @param {boolean} [raw=false] - 内部使用，设为 true 跳过加密
   * @returns {Promise<Object>} 发送结果
   */
  async send(sessionId, data, raw = false) {
    // 优先走 RTC DataChannel
    const dc = this.#localUser.rtc.getChannel(this.#userId, sessionId);
    if (dc?.readyState === "open") {
      const payload = await this.#preparePayload(data, raw);
      dc.send(payload);
      this.#recordRtcOutbound(sessionId, payload, data);
      this.#onSendComplete(sessionId, "rtc");
      return { status: "ok", via: "rtc" };
    }

    // 第一次 send 只走服务器中转，不触发 RTC，避免首次通信被信令干扰。
    // 从第二次 send 开始，后台静默触发 RTC 配对（失败无感）。
    const sentCount = this.#sendCounts.get(sessionId) || 0;
    this.#sendCounts.set(sessionId, sentCount + 1);
    if (sentCount >= 1 && !this.#rtcInitiated.has(sessionId)) {
      // 冷却期内跳过：刚断开的 session 立即重连大概率再次失败，
      // 且会造成 PC 风暴。冷却结束后下一次 send 会重新触发。
      const cooldownUntil = this.#rtcCooldownUntil.get(sessionId);
      const now = Date.now();
      if (!cooldownUntil || now >= cooldownUntil) {
        // console.log(
        //   `[RemoteUser] send() triggering rtc.connect: userId=${this.#userId}, sessionId=${sessionId}, sentCount=${sentCount}`,
        // );
        this.#rtcInitiated.add(sessionId);
        this.#rtcCooldownUntil.delete(sessionId);
        this.#localUser.rtc
          .connect(this.#userId, sessionId)
          .catch((err) => {
            console.warn(
              `[RemoteUser] send() rtc.connect failed: userId=${this.#userId}, sessionId=${sessionId}`,
              err,
            );
          });
      } else {
        // console.log(
        //   `[RemoteUser] send() rtc.connect skipped (cooldown): userId=${this.#userId}, sessionId=${sessionId}, remainingMs=${cooldownUntil - now}`,
        // );
      }
    }

    // RTC 未就绪，走服务器中转
    const { result, url } = await this.#sendViaServer(sessionId, data, raw);
    this.#onSendComplete(sessionId, "server", url);
    return { status: "ok", via: "server", url, result };
  }

  // ───── 用户间 Ping / Pong ─────

  /**
   * 监听 message 事件，拦截 __ping__ / __pong__ 协议消息。
   * 收到 ping 自动回复 pong；收到 pong 完成 RTT 计算。
   */
  #setupPingListener() {
    this.bind("message", (event) => {
      const { data } = event.detail;
      let parsed = data;
      if (typeof data === "string") {
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
      }
      if (!parsed || typeof parsed !== "object") return;

      if (parsed.type === "__ping__") {
        this.#handlePing(parsed, event.detail.fromSessionId);
      } else if (parsed.type === "__pong__") {
        this.#handlePong(parsed);
      } else if (parsed.type === "__storage_resp") {
        this.#handleStorageResponse(parsed);
      } else if (parsed.type === "cred") {
        // cred 协议只走服务器中转：对端 cred 处理器只监听 relay 消息，
        // 经 RTC 到达的 cred 消息不会有人处理。正常情况下不应出现，
        // 留告警便于诊断发送方路径异常。
        console.warn(
          `[RemoteUser] cred message received via RTC path (unhandled, cred protocol is server-relay only): from=${this.#userId} action=${parsed.action}`,
        );
      }
    });
  }

  /**
   * 收到 __ping__：自动回复 __pong__（走底层 #sendRaw，不影响 sendCounts）
   */
  async #handlePing(parsed, fromSessionId) {
    try {
      await this.#sendRaw(fromSessionId, {
        type: "__pong__",
        id: parsed.id,
        time: parsed.time,
      });
    } catch {
      // ping/pong 失败静默
    }
  }

  /**
   * 收到 __pong__：结算 RTT，更新 #rttMap，触发 rtt_update 事件
   */
  #handlePong(parsed) {
    const pending = this.#pendingPings.get(parsed.id);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    this.#pendingPings.delete(parsed.id);

    const rtt = Date.now() - parsed.time;
    pending.resolve(rtt);
    // 注：#onPongResolved 在 ping() 的 .then 中统一处理
  }

  /**
   * 底层直接发送 payload（不走 E2EE、不计数、不触发 RTC 连接）。
   * 优先走 RTC DataChannel，否则走服务器中转。
   * @returns {Promise<{status: string, via: string}>}
   */
  async #sendRaw(sessionId, payload) {
    const dc = this.#localUser.rtc.getChannel(this.#userId, sessionId);
    if (dc?.readyState === "open") {
      const wire = JSON.stringify(payload);
      dc.send(wire);
      this.#recordRtcOutbound(sessionId, wire, payload);
      this.#lastSendVia.set(sessionId, { via: "rtc" });
      return { status: "ok", via: "rtc" };
    }
    const { url } = await this.#localUser.server.sendToUser(this.#userId, sessionId, payload);
    this.#lastSendVia.set(sessionId, { via: "server", url });
    return { status: "ok", via: "server", url };
  }

  /**
   * 记录 RTC 出站流量元数据
   * @param {string} sessionId
   * @param {*} wirePayload - 实际写入 DataChannel 的数据（用于测量链路字节）
   * @param {*} originalData - 应用层数据（用于分类）
   */
  #recordRtcOutbound(sessionId, wirePayload, originalData) {
    const traffic = this.#localUser.traffic;
    if (!traffic) return;
    try {
      let category = "relay";
      let messageType = "relay";
      let appId = "";
      if (originalData && typeof originalData === "object" && originalData.__app) {
        category = "app";
        messageType = "__app";
        appId = originalData.__app;
      } else if (originalData && typeof originalData === "object") {
        const info = inferCategory(originalData);
        category = info.category;
        messageType = info.messageType;
        appId = info.appId;
      }
      traffic.record({
        direction: "out",
        via: "rtc",
        serverUrl: "",
        peerUserId: this.#userId,
        sessionId,
        size: measureSize(wirePayload),
        category,
        messageType,
        appId,
        success: true,
      });
    } catch (err) {
      console.warn("[TrafficLogger] record RTC outbound failed:", err);
    }
  }

  /**
   * 向目标 session 发起一次 ping，返回该次 RTT（毫秒）。
   * 底层走 #sendRaw，自动适应当前传输路径（RTC 或服务器中转）。
   *
   * @param {string} sessionId
   * @param {number} [timeout=5000]
   * @returns {Promise<number>} RTT（毫秒）
   */
  async ping(sessionId, timeout = 5000) {
    const id = `ping_${++this.#pingSeq}_${Date.now()}`;
    const time = Date.now();

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.#pendingPings.delete(id);
        reject(new Error("Ping timeout"));
      }, timeout);

      this.#pendingPings.set(id, { sessionId, resolve, reject, timeoutId });

      this.#sendRaw(sessionId, { type: "__ping__", id, time }).catch(
        (err) => {
          clearTimeout(timeoutId);
          this.#pendingPings.delete(id);
          reject(err);
        },
      );
    }).then((rtt) => {
      // ping 成功后写入缓存并触发事件
      const record = this.#lastSendVia.get(sessionId);
      const via = record?.via || "unknown";
      const url = record?.url;
      this.#rttMap.set(sessionId, { rtt, via, url, timestamp: Date.now() });
      this.#localUser._trigger("rtt_update", {
        userId: this.#userId,
        sessionId,
        rtt,
        via,
        url,
      });
      return rtt;
    });
  }

  /**
   * 强制对指定 session 重新测量 RTT（由外部触发，如 RTC 状态变化）。
   * 失败时静默返回 null。
   *
   * @param {string} sessionId
   * @returns {Promise<number|null>}
   */
  async recalcRTT(sessionId) {
    try {
      return await this.ping(sessionId);
    } catch {
      return null;
    }
  }

  /**
   * 处理 RTC 状态变化（由 LocalUser 的 rtc_state 监听器调用）。
   *
   * disconnected 时清理该 session 的"已触发 RTC"标记与路径缓存，
   * 使下一次 send() 能重新发起 rtc.connect()，避免对端刷新 / 网络抖动后
   * 永久退化为服务端中转。同时进入冷却期，防止 PC 反复重建。
   *
   * 注意：#sendCounts 不清零 —— RTC 触发条件是 sentCount >= 1，
   * 清零会让下一次 send 又被当作"首次 send"延迟一轮才触发 RTC。
   *
   * @param {string} sessionId
   * @param {"connected"|"disconnected"} state
   */
  _handleRTCStateChange(sessionId, state) {
    // console.log(
    //   `[RemoteUser] _handleRTCStateChange: userId=${this.#userId}, sessionId=${sessionId}, state=${state}`,
    // );
    if (state !== "disconnected") return;
    const hadInitiated = this.#rtcInitiated.has(sessionId);
    this.#rtcInitiated.delete(sessionId);
    this.#lastSendVia.delete(sessionId);
    const cooldownUntil = Date.now() + this.#RECONNECT_COOLDOWN_MS;
    this.#rtcCooldownUntil.set(sessionId, cooldownUntil);
    // console.log(
    //   `[RemoteUser] _handleRTCStateChange cleared: userId=${this.#userId}, sessionId=${sessionId}, hadInitiated=${hadInitiated}, cooldownUntil=${cooldownUntil} (${this.#RECONNECT_COOLDOWN_MS}ms)`,
    // );
  }

  /**
   * 销毁 RemoteUser，清理所有内部状态和定时器。
   * 由 LocalUser.disconnectUser 调用，避免 RemoteUser 被 GC 前残留定时器/状态。
   * 注意：底层 PC 资源由 RTCManager.disconnectAllForUser 单独清理。
   */
  dispose() {
    // console.log(
    //   `[RemoteUser] dispose: userId=${this.#userId}, pendingPings=${this.#pendingPings.size}, rtcInitiated=${this.#rtcInitiated.size}`,
    // );
    // 清理所有 pending ping 的定时器，防止 dispose 后定时器仍触发
    for (const { timeoutId } of this.#pendingPings.values()) {
      clearTimeout(timeoutId);
    }
    this.#pendingPings.clear();
    this.#sendCounts.clear();
    this.#rtcInitiated.clear();
    this.#rttMap.clear();
    this.#lastSendVia.clear();
    this.#rtcCooldownUntil.clear();
    this.#serviceSessionCache.clear();
    this.#serviceWaiters.clear();
    // 清理挂起的共享存储请求定时器与代理缓存
    for (const { timeoutId } of this.#pendingStorageReqs.values()) {
      clearTimeout(timeoutId);
    }
    this.#pendingStorageReqs.clear();
    this.#storageProxies.clear();
    this.#pingSeq = 0;
  }

  /**
   * 获取目标 session 的最新 RTT、传输方式及服务器 URL（若走服务端）。
   * 不传 sessionId 时返回所有 session 中的最佳（最低 RTT）结果。
   *
   * @param {string} [sessionId]
   * @returns {{ rtt: number, via: string, url?: string }|null}
   */
  getRTT(sessionId) {
    if (sessionId) {
      const entry = this.#rttMap.get(sessionId);
      return entry ? { rtt: entry.rtt, via: entry.via, url: entry.url } : null;
    }
    // 返回所有 session 中最低的 RTT
    let best = null;
    for (const entry of this.#rttMap.values()) {
      if (best === null || entry.rtt < best.rtt) {
        best = entry;
      }
    }
    return best ? { rtt: best.rtt, via: best.via, url: best.url } : null;
  }

  // ───── 应用服务发现与通信 ─────

  /**
   * 查询对方所有运行指定 appId 的 session。
   *
   * 通过 relay 协议向对方每个 session 发送查询，
   * 服务端不感知 appId 信息（私密模式）。
   *
   * @param {string} appId - 应用唯一标识
   * @param {number} [timeout=3000] - 等待响应的超时时间（毫秒）
   * @returns {Promise<Array<{ sessionId: string }>>} 匹配的 session 列表
   */
  async getServiceSessions(appId, timeout = 3000) {
    const sessionIds = await this.getSessionIds();
    if (sessionIds.length === 0) return [];

    const queryId = `sq_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const remaining = new Set(sessionIds);
    const matched = [];

    return new Promise((resolve) => {
      const handler = (event) => {
        const { data } = event.detail;
        // relay 过来的数据可能是已经解析好的对象，也可能是 JSON 字符串
        let parsed = data;
        if (typeof data === "string") {
          try {
            parsed = JSON.parse(data);
          } catch {
            return;
          }
        }
        if (!parsed || typeof parsed !== "object") return;
        if (parsed.type === "__service_response" && parsed.id === queryId) {
          remaining.delete(event.detail.fromSessionId);
          if (parsed.services.includes(appId)) {
            matched.push({ sessionId: event.detail.fromSessionId });
          }
          if (remaining.size === 0) {
            unbind();
            resolve(matched);
          }
        }
      };

      const unbind = this.bind("message", handler);

      // 向每个 session 发送查询
      for (const sid of sessionIds) {
        this.#sendRaw(sid, { type: "__service_query", id: queryId }).catch(() => {
          remaining.delete(sid);
        });
      }

      // 超时保护
      setTimeout(() => {
        unbind();
        resolve(matched);
      }, timeout);
    });
  }

  /**
   * 向对方的指定应用发送数据。
   *
   * 数据会自动包裹 __app 字段，接收方 LocalUser 会据此路由到对应 handler。
   * 服务端只看到加密后的二进制帧或普通 relay 数据，不感知 appId。
   *
   * 默认行为（未指定 sessionId）：
   * 1. 通过服务发现（含缓存）找到对端注册了 appId 的所有 session。
   * 2. 精准发送到这些 session，不再盲广播。
   * 3. 若无 session 注册该 app：
   *    - `waitForService > 0` 时挂起等待，直到对端上线该服务或超时；
   *    - 否则立刻返回 `[{ status: "no_receiver", appId }]`。
   * 4. 若对端完全离线，返回 `[{ status: "offline" }]`。
   * 5. 服务发现本身失败（超时无响应），返回 `[{ status: "discovery_failed", appId }]`
   *    或在 `fallback: "broadcast"` 时退化为老式广播。
   *
   * 指定 sessionId 时：直接发到该 session（若该 session 未注册此 app，接收方静默丢弃）。
   *
   * @param {string} appId - 目标应用标识
   * @param {*} data - 要发送的数据（JSON 可序列化对象）
   * @param {Object} [options]
   * @param {string} [options.sessionId] - 指定目标 sessionId（不传则精准投递到装了 appId 的所有 session）
   * @param {number} [options.waitForService=0] - 无接收者时等待对端上线的毫秒数
   * @param {"none"|"broadcast"} [options.fallback="none"] - 服务发现失败时的兜底策略
   * @returns {Promise<Array<{ sessionId?: string, status: string, via?: string, appId?: string, delivered?: boolean, error?: string }>>}
   */
  async sendToService(appId, data, options = {}) {
    const {
      sessionId: targetSessionId,
      waitForService = 0,
      fallback = "none",
    } = options || {};

    if (targetSessionId) {
      // 显式定向：不做服务发现，交给对端自行判断
      try {
        const result = await this.send(targetSessionId, {
          __app: appId,
          __data: data,
        });
        return [{ sessionId: targetSessionId, ...result }];
      } catch (err) {
        return [{
          sessionId: targetSessionId,
          status: "error",
          error: err?.message || String(err),
        }];
      }
    }

    // 精准投递路径：先解析目标 session 集合
    let targets;
    try {
      targets = await this.#resolveServiceTargets(appId);
    } catch {
      targets = null;
    }

    // 服务发现失败（超时未拿到任何响应，且无缓存兜底）
    if (targets === null) {
      if (fallback === "broadcast") {
        return this.#broadcastToAllSessions(appId, data);
      }
      return [{ status: "discovery_failed", appId }];
    }

    // 对端不在线（服务器查不到任何 session）
    if (targets.offline) {
      return [{ status: "offline" }];
    }

    // 有 session 但没人注册该 appId
    if (targets.sessions.length === 0) {
      if (waitForService > 0) {
        const waited = await this.#waitForServiceAvailable(appId, waitForService);
        if (waited.length > 0) {
          return this.#deliverToSessions(appId, data, waited);
        }
      }
      return [{ status: "no_receiver", appId }];
    }

    return this.#deliverToSessions(appId, data, targets.sessions);
  }

  /**
   * 解析对端注册了指定 appId 的 session 列表。
   * 逻辑：
   * 1. 命中未过期缓存 → 直接使用
   * 2. 查询服务器获取全部 session：
   *    - 服务器返回空 → 对端 offline
   *    - 有 session → 发起 __service_query 询问 appId 归属并写入缓存
   * @returns {Promise<{ sessions: string[], offline?: boolean } | null>}
   *          返回 null 表示服务发现流程本身失败（无 session 响应且无缓存）
   */
  async #resolveServiceTargets(appId) {
    const cached = this.#serviceSessionCache.get(appId);
    if (cached && Date.now() - cached.timestamp < this.#SERVICE_CACHE_TTL) {
      return { sessions: [...cached.sessions] };
    }

    const sessionIds = await this.getSessionIds();
    if (sessionIds.length === 0) {
      // 完全离线；清空该 appId 缓存
      this.#serviceSessionCache.delete(appId);
      return { sessions: [], offline: true };
    }

    // 通过 __service_query 询问每个 session 是否注册了 appId
    const found = await this.getServiceSessions(appId);
    const sessions = found.map((x) => x.sessionId);

    // 记录新的缓存（即使 sessions 为空也缓存，避免频繁询问）
    this.#serviceSessionCache.set(appId, {
      sessions,
      timestamp: Date.now(),
    });
    return { sessions };
  }

  /**
   * 向解析好的 session 列表投递 __app 消息
   */
  async #deliverToSessions(appId, data, sessionIds) {
    const results = [];
    for (const sid of sessionIds) {
      try {
        const result = await this.send(sid, {
          __app: appId,
          __data: data,
        });
        results.push({ sessionId: sid, ...result, delivered: true });
      } catch (err) {
        // send 失败通常意味着该 session 已离线，主动使缓存失效
        this.#invalidateServiceSession(appId, sid);
        results.push({
          sessionId: sid,
          status: "error",
          error: err?.message || String(err),
        });
      }
    }
    return results;
  }

  /**
   * 兜底：向对端所有 session 广播（老行为，仅在 fallback: "broadcast" 时使用）
   */
  async #broadcastToAllSessions(appId, data) {
    const sessionIds = await this.getSessionIds();
    const results = [];
    for (const sid of sessionIds) {
      try {
        const result = await this.send(sid, {
          __app: appId,
          __data: data,
        });
        results.push({ sessionId: sid, ...result });
      } catch (err) {
        results.push({
          sessionId: sid,
          status: "error",
          error: err?.message || String(err),
        });
      }
    }
    return results;
  }

  /**
   * 等待对端上线指定 appId（由 __service_available 触发）
   * @returns {Promise<string[]>} 命中时返回最新的 session 列表；超时返回空数组
   */
  #waitForServiceAvailable(appId, timeoutMs) {
    return new Promise((resolve) => {
      if (!this.#serviceWaiters.has(appId)) {
        this.#serviceWaiters.set(appId, new Set());
      }
      const bucket = this.#serviceWaiters.get(appId);

      let done = false;
      const finish = (sessions) => {
        if (done) return;
        done = true;
        bucket.delete(waiter);
        if (bucket.size === 0) this.#serviceWaiters.delete(appId);
        clearTimeout(timer);
        resolve(sessions);
      };

      const waiter = { resolve: finish };
      bucket.add(waiter);

      const timer = setTimeout(() => finish([]), timeoutMs);
    });
  }

  /**
   * 内部：收到对端 __service_available/__service_unavailable 时更新缓存并唤醒等待者
   * 由 LocalUser 分发消息时调用
   * @param {string} appId
   * @param {string} fromSessionId
   * @param {boolean} available
   */
  _handleServiceAvailability(appId, fromSessionId, available) {
    const now = Date.now();
    const cached = this.#serviceSessionCache.get(appId);
    const sessions = new Set(cached?.sessions || []);
    if (available) {
      sessions.add(fromSessionId);
    } else {
      sessions.delete(fromSessionId);
    }
    this.#serviceSessionCache.set(appId, {
      sessions: [...sessions],
      timestamp: now,
    });

    if (available) {
      const bucket = this.#serviceWaiters.get(appId);
      if (bucket && bucket.size > 0) {
        const snapshot = [...sessions];
        for (const w of [...bucket]) {
          w.resolve(snapshot);
        }
      }
    }
  }

  /**
   * 内部：本地 ServiceRegistry 上/下线 appId 时通知对端刷新其缓存
   * 静默失败（对端可能不在线）
   * @param {string} appId
   * @param {boolean} available
   */
  async _notifyServiceChange(appId, available) {
    const type = available ? "__service_available" : "__service_unavailable";
    let sessionIds;
    try {
      sessionIds = await this.getSessionIds();
    } catch {
      return;
    }
    for (const sid of sessionIds) {
      // raw=true：这类协议消息不做 E2EE，走中继/RTC 底层通道即可
      this.#sendRaw(sid, { type, appId }).catch(() => {});
    }
  }

  /**
   * 让指定 appId + sessionId 的缓存条目失效（如发送失败时使用）
   */
  #invalidateServiceSession(appId, sessionId) {
    const cached = this.#serviceSessionCache.get(appId);
    if (!cached) return;
    const next = cached.sessions.filter((s) => s !== sessionId);
    if (next.length === 0) {
      this.#serviceSessionCache.delete(appId);
    } else {
      this.#serviceSessionCache.set(appId, {
        sessions: next,
        timestamp: cached.timestamp,
      });
    }
  }

  /**
   * send 完成后调用：记录本次 via 和 url，若路径发生变化则自动触发 ping
   */
  #onSendComplete(sessionId, via, url) {
    const lastVia = this.#lastSendVia.get(sessionId);
    if (lastVia && lastVia.via !== via) {
      // 传输路径变化（server ↔ rtc），重新测量 RTT
      this.recalcRTT(sessionId);
    }
    this.#lastSendVia.set(sessionId, { via, url });
  }

  /**
   * 准备通过 DataChannel 发送的 payload。
   * 对象默认尝试 E2EE 加密；加密失败或明文模式则序列化为 JSON 字符串。
   * 二进制类型原样返回。
   */
  async #preparePayload(data, raw) {
    const isPlainObject =
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      !ArrayBuffer.isView(data) &&
      !(data instanceof Blob);

    if (!raw && isPlainObject) {
      const encrypted = await tryEncryptBinary(
        this.#localUser,
        this.#userId,
        data,
      );
      if (encrypted !== null) {
        return encrypted;
      }
      return JSON.stringify(data);
    }

    if (
      typeof data !== "string" &&
      !(data instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(data) &&
      !(data instanceof Blob)
    ) {
      return JSON.stringify(data);
    }

    return data;
  }

  /**
   * 通过服务器中转发送数据（保持原有 E2EE 与明文逻辑）
   */
  async #sendViaServer(sessionId, data, raw) {
    // 仅对纯对象启用 E2EE 加密（跳过数组、Uint8Array 等二进制数据）
    if (
      !raw &&
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      !ArrayBuffer.isView(data) &&
      !(data instanceof Blob)
    ) {
      const encrypted = await tryEncryptBinary(
        this.#localUser,
        this.#userId,
        data,
      );
      if (encrypted !== null) {
        // 加密成功，以二进制帧形式发送，零 base64 开销
        return this.#localUser.server.sendToUser(
          this.#userId,
          sessionId,
          encrypted,
        );
      }
    }
    return this.#localUser.server.sendToUser(this.#userId, sessionId, data);
  }
}
