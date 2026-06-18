import { BaseUser } from "../base-user.js";
import { tryEncryptBinary } from "../../crypto/crypto-e2ee.js";

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
  #rttMap = new Map(); // sessionId -> { rtt, via, timestamp }
  #pendingPings = new Map(); // pingId -> { sessionId, resolve, reject, timeoutId }
  #lastSendVia = new Map(); // sessionId -> 'rtc' | 'server'
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
    const result = await this.#sendViaServer(sessionId, data, raw);
    this.#onSendComplete(sessionId, "server");
    return result;
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
      return { status: "ok", via: "rtc" };
    }
    await this.#localUser.server.sendToUser(this.#userId, sessionId, payload);
    return { status: "ok", via: "server" };
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
      const via = this.#lastSendVia.get(sessionId) || "unknown";
      this.#rttMap.set(sessionId, { rtt, via, timestamp: Date.now() });
      this.#localUser._trigger("rtt_update", {
        userId: this.#userId,
        sessionId,
        rtt,
        via,
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
   * 获取目标 session 的最新 RTT。
   * 不传 sessionId 时返回所有 session 中的最佳（最低）RTT。
   *
   * @param {string} [sessionId]
   * @returns {number|null}
   */
  getRTT(sessionId) {
    if (sessionId) {
      return this.#rttMap.get(sessionId)?.rtt ?? null;
    }
    // 返回所有 session 中最低的 RTT
    let best = null;
    for (const entry of this.#rttMap.values()) {
      if (best === null || entry.rtt < best) {
        best = entry.rtt;
      }
    }
    return best;
  }

  /**
   * send 完成后调用：记录本次 via，若路径发生变化则自动触发 ping
   */
  #onSendComplete(sessionId, via) {
    const lastVia = this.#lastSendVia.get(sessionId);
    if (lastVia && lastVia !== via) {
      // 传输路径变化（server ↔ rtc），重新测量 RTT
      this.recalcRTT(sessionId);
    }
    this.#lastSendVia.set(sessionId, via);
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
