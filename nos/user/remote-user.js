import { BaseUser } from "./base-user.js";
import { tryEncryptBinary } from "../crypto/crypto-e2ee.js";

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
      this.#onSendComplete(sessionId, "rtc");
      return { status: "ok", via: "rtc" };
    }

    // 第一次 send 只走服务器中转，不触发 RTC，避免首次通信被信令干扰。
    // 从第二次 send 开始，后台静默触发 RTC 配对（失败无感）。
    const sentCount = this.#sendCounts.get(sessionId) || 0;
    this.#sendCounts.set(sessionId, sentCount + 1);
    if (sentCount >= 1 && !this.#rtcInitiated.has(sessionId)) {
      this.#rtcInitiated.add(sessionId);
      this.#localUser.rtc.connect(this.#userId, sessionId).catch(() => {});
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
      dc.send(JSON.stringify(payload));
      this.#lastSendVia.set(sessionId, { via: "rtc" });
      return { status: "ok", via: "rtc" };
    }
    const { url } = await this.#localUser.server.sendToUser(this.#userId, sessionId, payload);
    this.#lastSendVia.set(sessionId, { via: "server", url });
    return { status: "ok", via: "server", url };
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
   * 不传 sessionId 时：广播给对方所有 session，接收方自动丢弃未注册 app 的消息。
   * 指定 sessionId 时：只发送给该 session（不匹配时接收方静默丢弃）。
   *
   * @param {string} appId - 目标应用标识
   * @param {*} data - 要发送的数据（JSON 可序列化对象）
   * @param {Object} [options]
   * @param {string} [options.sessionId] - 指定目标 sessionId（不传则发给所有 session）
   * @returns {Promise<Array<{ sessionId: string, status: string, via?: string }>>}
   */
  async sendToService(appId, data, options = {}) {
    const { sessionId: targetSessionId } = options || {};

    if (targetSessionId) {
      // 发给指定 session（若该 session 未注册此 app，接收方静默丢弃）
      const result = await this.send(targetSessionId, {
        __app: appId,
        __data: data,
      });
      return [{ sessionId: targetSessionId, ...result }];
    }

    // 广播给所有 session，接收方会静默丢弃未注册 app 的消息
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
          error: err.message,
        });
      }
    }
    return results;
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
