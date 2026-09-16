import { BaseUser } from "./base-user.js";
import { tryEncryptBinary } from "../crypto/crypto-e2ee.js";
import { inferCategory, measureSize } from "./traffic.js";
import { createMsgId, AckWaiter } from "./reliable.js";
import { getStorage } from "../storage/main.js";

/**
 * 控制类消息：永远走服务器中继（TCP 可靠、通道切换期间不丢）。
 * __ping__/__pong__ 除外——它们负责测量 RTC 路径质量，必须允许走 RTC。
 */
const CONTROL_RELAY_ONLY_TYPES = new Set([
  "cred",
  "__ack",
  "__service_query",
  "__service_response",
  "__service_available",
  "__service_unavailable",
  "__storage_req",
  "__storage_resp",
]);

/**
 * 以非枚举方式挂载属性。
 *
 * acked / flushed 是活的 Promise：必须可显式访问（results[0].acked），
 * 但不可被结构化克隆 / JSON 序列化枚举到——否则任何把结果对象
 * postMessage 外传的消费者（测试框架、Worker 等）都会 DataCloneError。
 */
function defineHidden(obj, key, value) {
  Object.defineProperty(obj, key, {
    value,
    enumerable: false,
    writable: true,
    configurable: true,
  });
}

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

  // ───── 可靠投递（信封 / ACK / 离线队列） ─────
  // 信封序号：本 RemoteUser 内单调递增，随 __env 发出供观测
  #msgSeq = 0;
  // msgId -> 挂起的 ACK 等待（接收端核心层自动回 __ack）
  #ackWaiter = new AckWaiter();
  // 对端曾回过 __ack → 说明对端支持核心层去重，此后自动重发才安全
  #peerSupportsAck = false;
  // 离线队列：{ message, appId, sessionId, ackTimeout, retries, queuedAt, settle }
  #sendQueue = [];
  #flushing = false;
  // 离线队列持久化（nos/storage，独立存储空间，key = q:<userId>:<msgId>）：
  // 发送方刷新页面后队列可恢复，长离线场景的投递兜底由发送端负责
  #queueStore = getStorage("nos-user-queue");
  #queueRestorePromise = null;
  // 队列仍不可达时的重冲刷定时器（退避 1.5s → 30s）
  #reflushTimer = null;
  #reflushDelay = 1500;
  #REFLUSH_BASE = 1500;
  #REFLUSH_MAX = 30000;
  // 离线队列容量上限与条目 TTL。
  // 队列已持久化（nos/storage 落 IndexedDB），刷新页面不丢，
  // 因此 TTL 可以覆盖「对端长期离线」的长窗口（服务器侧收件箱只兜 1h 热缓冲）
  #QUEUE_MAX = 200;
  #QUEUE_TTL = 24 * 60 * 60 * 1000;
  // 默认 ACK 等待超时（毫秒）；0 或负数 = 不跟踪 ACK
  #DEFAULT_ACK_TIMEOUT = 5000;
  // 大 payload 拉取化阈值（字节）：序列化体积超过即转「manifest + 拉取」
  #LARGE_PAYLOAD_THRESHOLD = 64 * 1024;

  // ───── 端到端存活检测（阶段一第 4 步） ─────
  // 心跳只证明「我对服务器活着」，不证明「对端活着」。这里对已建立过
  // 通信的 session 周期性做全路径 echo（A→server→B→server→A），
  // 间隔 25s（低于常见 NAT 超时），死亡转换时主动失效服务发现缓存。
  #livenessTimer = null;
  #LIVENESS_INTERVAL = 25000;
  // sessionId -> 最近一次检测结果（true/false），用于死亡/复活转换判定
  #lastLiveness = new Map();
  #disposed = false;

  // ───── 通道分类与切换屏障（阶段三第 8 步） ─────
  // 每个 session 的在途 relay 发送计数（以服务器 relay_response 回执为界）
  #relayInFlight = new Map(); // sessionId -> count
  #relayDrain = new Map(); // sessionId -> drain promise
  // 同一 session 的发送闸门链：sessionId -> 最后一条在闸门中/已完成
  // 「载荷准备 → 写线路」的 Promise。并发 send() 按调用顺序串行上线，
  // 避免加密等异步准备的完成顺序决定线路写入顺序（同通道乱序）。
  #wireGates = new Map();
  #relayDrainRelease = new Map(); // sessionId -> release fn

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
    // 异步恢复上次会话遗留的离线队列（对端仍离线时由退避定时器续投）
    this.#queueRestorePromise = this.#restoreQueue();
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
   * @param {string|null} [sessionId] - 目标会话 ID；**省略时为身份寻址广播**：
   *        投递到目标用户当前的所有 session（对端各标签页各收到一份）
   * @param {*} data - 要发送的数据（JSON 可序列化值）
   * @param {boolean} [raw=false] - 内部使用，设为 true 跳过加密
   * @returns {Promise<Object>} 发送结果；广播时为
   *          `{ status: "ok", via: "broadcast", delivered: number, total: number }`
   */
  async send(sessionId, data, raw = false) {
    // 身份寻址：sessionId 省略时广播到对端全部 session
    if (sessionId == null || sessionId === "") {
      return this.#sendToAllSessions(data, raw);
    }

    // 控制类消息永远走服务器中继（TCP 可靠，通道切换期间不丢）
    const forceRelay = this.#isControlMessage(data);

    // 同一 session 的发送闸门：send() 允许并发调用，但加密等异步准备
    // 的完成顺序不等于调用顺序（Firefox 的 native crypto 尤其明显），
    // 会造成同通道发送乱序。闸门按调用顺序放行——前一条的载荷写进线路
    // （WS 同步帧 / dc.send）后下一条才开始准备。relay_response 的等待
    // 在闸门外进行，不引入响应级队头阻塞。
    const prevTurn = this.#wireGates.get(sessionId);
    let releaseNext;
    const released = new Promise((r) => (releaseNext = r));
    const myTurn = prevTurn ? prevTurn.then(() => released) : released;
    this.#wireGates.set(sessionId, myTurn);

    try {
      await prevTurn; // 等前一条的载荷写进线路

      // 闸门内重新确认通道：排队等待期间通道状态可能变化
      let dc = forceRelay
        ? null
        : this.#localUser.rtc.getChannel(this.#userId, sessionId);
      if (dc?.readyState === "open") {
        // 切换屏障：同 session 还有在途 relay（或上一条走的是 relay）时，
        // 先等它们拿到服务器回执（字节已写入对端 TCP 流）再切 RTC，
        // 消除 relay→RTC 切换瞬间的跨通道乱序窗口。
        // 屏障必须在闸门内复核：排队期间前序 relay 可能尚未上线。
        if (
          this.#relayInFlight.get(sessionId) ||
          this.#lastSendVia.get(sessionId)?.via === "server"
        ) {
          await this.#waitRelayDrained(sessionId);
          // 等待期间通道可能又关闭了，回落服务器中继
          if (dc.readyState !== "open") {
            dc = null;
          }
        }
      }

      if (dc?.readyState === "open") {
        const payload = await this.#preparePayload(data, raw);
        // 准备期间通道可能关闭，回落服务器中继
        if (dc.readyState !== "open") {
          dc = null;
        } else {
          dc.send(payload);
          this.#recordRtcOutbound(sessionId, payload, data);
          this.#onSendComplete(sessionId, "rtc");
          return { status: "ok", via: "rtc" };
        }
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
        }
      }

      // RTC 未就绪，走服务器中转（计入切换屏障的在途统计）
      let payload = data;
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
          payload = encrypted;
        }
      }
      const relayPromise = this.#localUser.server.sendToUser(
        this.#userId,
        sessionId,
        payload,
      );
      // 闸门内登记在途 relay：排在本条之后的消息复核屏障时必须看到它
      this.#trackRelaySend(sessionId, relayPromise);
      const { result, url } = await relayPromise;
      this.#onSendComplete(sessionId, "server", url);
      return { status: "ok", via: "server", url, result };
    } finally {
      // 无论成败都放行下一条，防止队列卡死
      releaseNext();
    }
  }

  /**
   * 判断是否为控制类消息（永远走服务器中继）
   */
  #isControlMessage(payload) {
    return !!(
      payload &&
      typeof payload === "object" &&
      !ArrayBuffer.isView(payload) &&
      CONTROL_RELAY_ONLY_TYPES.has(payload.type)
    );
  }

  /**
   * 记录一次在途 relay 发送：以服务器 relay_response 回执为界，
   * 供同 session 的 relay→RTC 切换屏障等待排空
   */
  #trackRelaySend(sessionId, promise) {
    this.#relayInFlight.set(
      sessionId,
      (this.#relayInFlight.get(sessionId) || 0) + 1,
    );
    const release = () => {
      const left = (this.#relayInFlight.get(sessionId) || 1) - 1;
      if (left <= 0) {
        this.#relayInFlight.delete(sessionId);
        const releaseFn = this.#relayDrainRelease.get(sessionId);
        if (releaseFn) {
          this.#relayDrainRelease.delete(sessionId);
          this.#relayDrain.delete(sessionId);
          releaseFn();
        }
      } else {
        this.#relayInFlight.set(sessionId, left);
      }
    };
    promise.then(release, release);
  }

  /**
   * 等待指定 session 的在途 relay 全部拿到服务器回执
   */
  #waitRelayDrained(sessionId) {
    if (!this.#relayInFlight.get(sessionId)) return Promise.resolve();
    let drain = this.#relayDrain.get(sessionId);
    if (!drain) {
      drain = new Promise((resolve) =>
        this.#relayDrainRelease.set(sessionId, resolve),
      );
      this.#relayDrain.set(sessionId, drain);
    }
    return drain;
  }

  /**
   * 身份寻址广播：向目标用户当前所有 session 投递同一份数据。
   * 任一 session 成功即视为成功；全部失败时抛出首个错误。
   */
  async #sendToAllSessions(data, raw) {
    const sessionIds = await this.getSessionIds();
    if (sessionIds.length === 0) {
      const err = new Error(`Target user ${this.#userId} is not online`);
      err.code = "offline";
      throw err;
    }
    const results = await Promise.allSettled(
      sessionIds.map((sid) => this.send(sid, data, raw)),
    );
    const delivered = results.filter((r) => r.status === "fulfilled").length;
    if (delivered === 0) {
      throw (
        results.find((r) => r.status === "rejected")?.reason ||
        new Error("Broadcast to all sessions failed")
      );
    }
    return {
      status: "ok",
      via: "broadcast",
      delivered,
      total: sessionIds.length,
    };
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
      } else if (parsed.type === "__ack") {
        // 对端核心层确认：标记能力 + 结算挂起的 acked 等待
        this.#peerSupportsAck = true;
        if (parsed.msgId) {
          if (parsed.ok === false) {
            // 确定性失败：对端 handler 未执行（no_handler / handler_error），
            // 结算为 confirmed:false 让发送方立即失败而非等超时
            this.#ackWaiter.resolveFailure(
              parsed.msgId,
              parsed.error || "handler_error",
              parsed.message,
            );
          } else {
            this.#ackWaiter.resolve(parsed.msgId, {
              duplicate: !!parsed.duplicate,
            });
          }
        }
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
   * 控制类消息永远走服务器中转（通道切换期间不丢）；
   * 其余优先走 RTC DataChannel，否则走服务器中转。
   * @returns {Promise<{status: string, via: string}>}
   */
  async #sendRaw(sessionId, payload) {
    const dc = this.#isControlMessage(payload)
      ? null
      : this.#localUser.rtc.getChannel(this.#userId, sessionId);
    if (dc?.readyState === "open") {
      const wire = JSON.stringify(payload);
      dc.send(wire);
      this.#recordRtcOutbound(sessionId, wire, payload);
      this.#lastSendVia.set(sessionId, { via: "rtc" });
      return { status: "ok", via: "rtc" };
    }
    const relayPromise = this.#localUser.server.sendToUser(
      this.#userId,
      sessionId,
      payload,
    );
    this.#trackRelaySend(sessionId, relayPromise);
    const { url } = await relayPromise;
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
    // 清理可靠投递状态：ACK 等待、离线队列与退避定时器
    this.#ackWaiter.clear();
    if (this.#reflushTimer) {
      clearTimeout(this.#reflushTimer);
      this.#reflushTimer = null;
    }
    for (const entry of this.#sendQueue) {
      entry.settle({ status: "dropped", reason: "disposed" });
      this.#unpersistEntry(entry);
    }
    this.#sendQueue = [];
    // 存活监视与检测结果
    if (this.#livenessTimer) {
      clearInterval(this.#livenessTimer);
      this.#livenessTimer = null;
    }
    this.#lastLiveness.clear();
    this.#disposed = true;
    // 切换屏障状态
    this.#relayInFlight.clear();
    this.#relayDrain.clear();
    this.#relayDrainRelease.clear();
    // 发送闸门（在途条目由各自 finally 放行，清表仅释放引用）
    this.#wireGates.clear();
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
    const { matched } = await this.#queryServiceSessions(appId, timeout);
    return matched;
  }

  /**
   * 服务查询内部实现：额外返回应答统计，供陈旧会话判定使用。
   * - matched: 注册了 appId 的 session 列表
   * - queried: 本次查询的全部 session
   * - responded: 实际应答了查询的 session 集合
   */
  async #queryServiceSessions(appId, timeout = 3000) {
    const sessionIds = await this.getSessionIds();
    if (sessionIds.length === 0) {
      return { matched: [], queried: [], responded: new Set() };
    }

    const queryId = `sq_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
    const remaining = new Set(sessionIds);
    const matched = [];
    const responded = new Set();

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
          responded.add(event.detail.fromSessionId);
          if (parsed.services.includes(appId)) {
            matched.push({ sessionId: event.detail.fromSessionId });
          }
          if (remaining.size === 0) {
            unbind();
            resolve({ matched, queried: sessionIds, responded });
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
        resolve({ matched, queried: sessionIds, responded });
      }, timeout);
    });
  }

  /**
   * 向对方的指定应用发送数据。
   *
   * 数据会自动包裹 __app 字段与 __env 信封（msgId/seq/ts），接收方核心层据此
   * 路由到对应 handler，并在 handler 执行完毕后自动回 __ack——发送方可通过
   * 返回项上的 `acked` Promise 等待"对端确实处理完"的终态。
   * 服务端只看到加密后的二进制帧或普通 relay 数据，不感知 appId。
   *
   * 默认行为（未指定 sessionId）：
   * 1. 通过服务发现（含缓存）找到对端注册了 appId 的所有 session。
   * 2. 精准发送到这些 session，不再盲广播。
   * 3. 若无 session 注册该 app：
   *    - `waitForService > 0` 时挂起等待，直到对端上线该服务或超时；
   *    - 否则立刻返回 `[{ status: "no_receiver", appId }]`。
   * 4. 若对端完全离线：默认进入离线队列，返回 `[{ status: "queued", flushed }]`，
   *    对端恢复后自动补投（`{ queue: false }` 退回旧行为 `[{ status: "offline" }]`）。
   * 5. 服务发现本身失败（超时无响应），返回 `[{ status: "discovery_failed", appId }]`
   *    或在 `fallback: "broadcast"` 时退化为老式广播。
   *
   * 指定 sessionId 时：直接发到该 session（不做服务发现）。
   *
   * 返回项字段：
   * - `status`: "ok" | "queued" | "no_receiver" | "offline" | "discovery_failed" | "error"
   * - `msgId`: 本条消息的信封 ID（重发/去重/ACK 均以它为凭据）
   * - `acked`: Promise，resolve `{ confirmed, reason?, duplicate? }`；
   *   confirmed=true 表示对端核心层已执行完 handler；
   *   对端为旧版本（不回 __ack）时超时后 resolve `{ confirmed: false, reason: "timeout" }`
   * - `flushed`: 仅 status="queued" 时存在，resolve `{ status: "delivered"|"expired"|"dropped"|"failed", reason?, results? }`；
   *   delivered 表示对端核心层已回 __ack 确认执行（旧版本对端无 __ack，
   *   退化为传输层成功即 delivered）；failed 携带对端确定性失败原因
   *
   * @param {string} appId - 目标应用标识
   * @param {*} data - 要发送的数据（JSON 可序列化对象）
   * @param {Object} [options]
   * @param {string} [options.sessionId] - 指定目标 sessionId（不传则精准投递到装了 appId 的所有 session）
   * @param {number} [options.waitForService=0] - 无接收者时等待对端上线的毫秒数
   * @param {"none"|"broadcast"} [options.fallback="none"] - 服务发现失败时的兜底策略
   * @param {number} [options.ackTimeout=5000] - 等待对端 __ack 的超时（毫秒）；≤0 关闭 acked 跟踪
   * @param {number} [options.retries=0] - ACK 超时时的自动重发次数（仅对已确认支持
   *          __ack 的对端生效，避免向旧版对端重发造成重复执行）
   * @param {boolean} [options.queue=true] - 对端离线时是否进入离线队列等待补投
   * @returns {Promise<Array<{ sessionId?: string, status: string, via?: string, appId?: string, delivered?: boolean, msgId?: string, acked?: Promise, flushed?: Promise, error?: string }>>}
   */
  async sendToService(appId, data, options = {}) {
    const {
      sessionId: targetSessionId,
      waitForService = 0,
      fallback = "none",
      ackTimeout = this.#DEFAULT_ACK_TIMEOUT,
      retries = 0,
      queue = true,
    } = options || {};

    const deliverOpts = { ackTimeout, retries, queue };

    if (targetSessionId) {
      // 显式定向：不做服务发现，交给对端自行判断
      const message = await this.#buildAppMessage(appId, data);
      try {
        const result = await this.send(targetSessionId, message);
        const item = {
          sessionId: targetSessionId,
          ...result,
          msgId: message.__env.msgId,
        };
        if (ackTimeout > 0) {
          defineHidden(
            item,
            "acked",
            this.#awaitMessageAck(message, [targetSessionId], deliverOpts),
          );
        }
        return [item];
      } catch (err) {
        if (queue && this.#isOfflineError(err)) {
          return [this.#enqueueMessage(message, appId, targetSessionId, deliverOpts)];
        }
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
        return this.#broadcastToAllSessions(appId, data, deliverOpts);
      }
      return [{ status: "discovery_failed", appId }];
    }

    // 对端不在线（服务器查不到任何 session）
    if (targets.offline) {
      if (queue) {
        const message = await this.#buildAppMessage(appId, data);
        // 优先服务端离线收件箱：对端重连即达，且不受本端刷新影响。
        // queue === "local" 跳过服务端存储；服务器旧版本（不支持
        // store_if_offline）或收件箱已满时同样回退本地队列
        if (queue !== "local" && (await this.#tryStoreOnServer(message))) {
          const item = {
            status: "queued",
            via: "server",
            appId,
            msgId: message.__env.msgId,
          };
          if (deliverOpts.ackTimeout > 0) {
            // 对端上线收到补投后核心层会回 __ack；离线期间正常超时
            defineHidden(
              item,
              "acked",
              this.#awaitMessageAck(message, [], deliverOpts),
            );
          }
          return [item];
        }
        return [this.#enqueueMessage(message, appId, null, deliverOpts)];
      }
      return [{ status: "offline" }];
    }

    // 有 session 但没人注册该 appId
    if (targets.sessions.length === 0) {
      if (waitForService > 0) {
        const waited = await this.#waitForServiceAvailable(appId, waitForService);
        if (waited.length > 0) {
          return this.#deliverToSessions(appId, data, waited, deliverOpts);
        }
      }
      return [{ status: "no_receiver", appId }];
    }

    return this.#deliverToSessions(appId, data, targets.sessions, deliverOpts);
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

    // 一次 queryUserOnline 同时拿到「全部 session」和「服务端注册表中的公开服务」
    // （sessionInfo[].services 来自对端 update_services 上报，仅含 exposeToServer 服务）
    const urls = this.#localUser.server.connectedUrls;
    const infos = await Promise.allSettled(
      urls.map((url) => this.#localUser.server.queryUserOnline(url, this.#userId)),
    );

    const sessionIds = new Set();
    const registryMatched = new Set();
    for (const r of infos) {
      if (r.status !== "fulfilled" || !r.value?.online) continue;
      for (const info of r.value.sessionInfo || []) {
        if (!info?.sessionId) continue;
        sessionIds.add(info.sessionId);
        if (Array.isArray(info.services) && info.services.includes(appId)) {
          registryMatched.add(info.sessionId);
        }
      }
    }

    if (sessionIds.size === 0) {
      // 完全离线；清空该 appId 缓存
      this.#serviceSessionCache.delete(appId);
      return { sessions: [], offline: true };
    }

    // 服务端注册表正命中（exposeToServer 服务）：权威结果，无需 P2P 逐个查询
    if (registryMatched.size > 0) {
      const sessions = [...registryMatched];
      this.#serviceSessionCache.set(appId, {
        sessions,
        timestamp: Date.now(),
      });
      return { sessions };
    }

    // P2P 查询（覆盖私密服务：服务端注册表看不到它们）
    const { matched, responded } = await this.#queryServiceSessions(appId);
    const sessions = matched.map((x) => x.sessionId);

    // 记录新的缓存（即使 sessions 为空也缓存，避免频繁询问）
    this.#serviceSessionCache.set(appId, {
      sessions,
      timestamp: Date.now(),
    });

    if (sessions.length === 0 && responded.size === 0) {
      // 列出了 session 但全部无应答：极可能是陈旧会话（对端已断开，
      // 服务器尚未清理）。不误报 no_receiver，回退为向原 session 列表
      // 投递——死 session 会按 offline 分类进入离线队列，活 session 会
      // 回明确的 no_handler ack。注意：此回退结果不写入缓存。
      return { sessions: [...sessionIds], stale: true };
    }

    return { sessions };
  }

  /**
   * 构造带 __env 信封的 __app 消息（msgId 同一次投递内固定，重发复用）。
   *
   * 大 payload 拉取化（阶段三第 9 步）：序列化体积超过阈值的数据不再内联，
   * 而是内容寻址发布（可 E2EE 加密后发布），消息只携带签名 manifest 与
   * 拉取引用 `{__pull: {fileHash, encrypted}}`，接收方拉取组装后还原。
   * 仅在对端支持核心层信封（#peerSupportsAck）时启用；发布失败回退内联。
   */
  async #buildAppMessage(appId, data) {
    const message = {
      __app: appId,
      __data: data,
      __env: { msgId: createMsgId(), seq: ++this.#msgSeq, ts: Date.now() },
    };

    if (
      this.#peerSupportsAck &&
      measureSize(data) > this.#LARGE_PAYLOAD_THRESHOLD
    ) {
      const ref = await this.#publishLargePayload(data).catch(() => null);
      if (ref) {
        message.__data = ref.manifest;
        message.__pull = {
          fileHash: ref.manifest.fileHash,
          encrypted: ref.encrypted,
        };
      }
    }
    return message;
  }

  /**
   * 内容寻址发布大 payload（供接收方按 chunk 拉取）。
   * E2EE 凭证可用时先加密字节再发布——服务器与拉取方都拿不到明文。
   * @returns {Promise<{manifest: Object, encrypted: boolean}|null>}
   */
  async #publishLargePayload(data) {
    try {
      // 0x00 前缀：加密后的分块对中间层而言必须是「不透明的二进制」。
      // 若直接加密 JSON，接收端 #handleBinaryRelay 的 E2EE 解密尝试会
      // 成功并把分块"还原"成对象分发，拉取方的二进制哈希匹配将永远失败。
      const jsonBytes = new TextEncoder().encode(JSON.stringify(data));
      let bytes = new Uint8Array(1 + jsonBytes.length);
      bytes[0] = 0;
      bytes.set(jsonBytes, 1);
      let encrypted = false;
      const { tryEncryptBytes } = await import("../crypto/crypto-e2ee.js");
      const enc = await tryEncryptBytes(this.#localUser, this.#userId, bytes);
      if (enc) {
        bytes = enc;
        encrypted = true;
      }
      const publisher = await this.#localUser._getDataPublisher();
      const manifest = await publisher.publish(new Blob([bytes]));
      return { manifest, encrypted };
    } catch (err) {
      console.warn("[RemoteUser] large payload publish failed:", err);
      return null;
    }
  }

  /**
   * 尝试把消息存入服务端离线收件箱（对端完全离线时）。
   * 逐个已连接服务器尝试，服务端回 `queued` 即成功；
   * `inbox_full` 视为该服务器不可用（继续尝试下一台，全部失败则回退本地队列）；
   * 旧版本服务端返回 error / 超时，同样回退本地队列。
   * @param {Object} message - 带 __env 信封的 __app 消息
   * @returns {Promise<boolean>} 是否已成功存入服务端
   */
  async #tryStoreOnServer(message) {
    const urls = this.#localUser.server.connectedUrls;
    if (urls.length === 0) return false;
    // 与 send 路径保持单一序列化：加密可用时传密文（二进制帧），
    // 否则传原始对象——不能用 #preparePayload 的字符串形态，
    // 否则 JSON relay 会把它二次序列化，接收方拿到的是字符串套字符串
    const encrypted = await tryEncryptBinary(
      this.#localUser,
      this.#userId,
      message,
    );
    const payload = encrypted !== null ? encrypted : message;
    for (const url of urls) {
      try {
        const result = await this.#localUser.server.relayStoreOffline(
          url,
          this.#userId,
          payload,
        );
        if (result?.status === "queued") return true;
        if (result?.status === "inbox_full") continue;
      } catch {
        // 该服务器失败（旧版本/离线），尝试下一台
      }
    }
    return false;
  }

  /**
   * 构造后向解析好的 session 列表投递 __app 消息
   */
  async #deliverToSessions(appId, data, sessionIds, opts = {}) {
    const message = await this.#buildAppMessage(appId, data);
    return this.#deliverMessage(message, sessionIds, opts);
  }

  /**
   * 向 session 列表投递一条已构造好的 __app 消息（离线补投复用同一信封）
   */
  async #deliverMessage(message, sessionIds, opts = {}) {
    const appId = message.__app;
    const { ackTimeout = this.#DEFAULT_ACK_TIMEOUT, retries = 0, queue = true } = opts;
    const results = [];
    const reachable = [];

    for (const sid of sessionIds) {
      try {
        const result = await this.send(sid, message);
        reachable.push(sid);
        results.push({
          sessionId: sid,
          ...result,
          delivered: true,
          msgId: message.__env.msgId,
        });
      } catch (err) {
        // send 失败通常意味着该 session 已离线，主动使缓存失效
        this.#invalidateServiceSession(appId, sid);
        if (queue && this.#isOfflineError(err)) {
          results.push(this.#enqueueMessage(message, appId, sid, opts));
          continue;
        }
        results.push({
          sessionId: sid,
          status: "error",
          msgId: message.__env.msgId,
          error: err?.message || String(err),
        });
      }
    }

    // 至少一条通道可达时挂起 ACK 等待；同一 msgId 的 acked 由所有投递项共享，
    // 任一目标 session 的核心层回 __ack 即结算
    if (reachable.length > 0 && ackTimeout > 0) {
      const acked = this.#awaitMessageAck(message, reachable, opts);
      for (const item of results) {
        if (item.delivered) defineHidden(item, "acked", acked);
      }
    }
    return results;
  }

  /**
   * 等待对端核心层 __ack，按需自动重发。
   *
   * 重发安全性：仅当对端曾回过 __ack（#peerSupportsAck，即对端具备核心层去重）
   * 才自动重发——向旧版对端重发同一 msgId 会造成 handler 重复执行。
   * no_handler / handler_error 是确定性失败，直接返回不重发。
   */
  async #awaitMessageAck(message, sessionIds, opts) {
    const { ackTimeout = this.#DEFAULT_ACK_TIMEOUT, retries = 0 } = opts;
    const msgId = message.__env.msgId;
    let attempt = 0;

    while (true) {
      const res = await this.#ackWaiter.wait(msgId, ackTimeout);
      if (res.confirmed) return res;
      if (res.reason && res.reason !== "timeout") return res;
      if (!this.#peerSupportsAck) {
        return { confirmed: false, reason: "timeout", retriable: false };
      }
      if (attempt >= retries) {
        return { confirmed: false, reason: "timeout", attempts: attempt + 1 };
      }
      attempt++;
      try {
        // 接收端按 msgId 去重，重发不会重复执行 handler
        await Promise.allSettled(
          sessionIds.map((sid) => this.send(sid, message)),
        );
      } catch (err) {
        return { confirmed: false, reason: "send_failed", error: err?.message };
      }
    }
  }

  /**
   * 判断发送失败是否为"对端不可达"类瞬时离线（可进入离线队列等待补投）。
   * 超时类错误不在此列：消息可能已送达，向旧版对端补投会重复执行。
   */
  #isOfflineError(err) {
    if (!err) return false;
    if (err.code === "offline") return true;
    const msg = String(err?.message || "");
    return msg.includes("is not online") || msg.includes("is not open");
  }

  /**
   * 离线队列持久化 key：q:<userId>:<msgId>
   */
  #queueKey(msgId) {
    return `q:${this.#userId}:${msgId}`;
  }

  /**
   * 把入队条目写入持久化存储（剥离 settle 等不可序列化字段）。
   * 写入失败不阻断投递流程，仅降级为纯内存队列。
   */
  #persistEntry(entry) {
    const msgId = entry.message?.__env?.msgId;
    if (!msgId) return;
    this.#queueStore
      .setItem(this.#queueKey(msgId), {
        message: entry.message,
        appId: entry.appId,
        sessionId: entry.sessionId ?? null,
        ackTimeout: entry.ackTimeout,
        retries: entry.retries,
        queuedAt: entry.queuedAt,
      })
      .catch(() => {});
  }

  /**
   * 条目出队（投递/过期/丢弃/销毁）后移除持久化记录
   */
  #unpersistEntry(entry) {
    const msgId = entry.message?.__env?.msgId;
    if (!msgId) return;
    this.#queueStore.removeItem(this.#queueKey(msgId)).catch(() => {});
  }

  /**
   * 从持久化存储恢复上次会话遗留的离线队列。
   * 恢复条目没有在途调用方，settle 为 no-op；
   * 与恢复期间新入队的条目按 msgId 去重，按 queuedAt 排序并入。
   */
  async #restoreQueue() {
    try {
      const prefix = `q:${this.#userId}:`;
      const restored = [];
      for await (const [key, value] of this.#queueStore.entries()) {
        if (!key.startsWith(prefix)) continue;
        if (!value || typeof value !== "object" || !value.message) {
          this.#queueStore.removeItem(key).catch(() => {});
          continue;
        }
        restored.push({
          message: value.message,
          appId: value.appId,
          sessionId: value.sessionId ?? null,
          ackTimeout: value.ackTimeout ?? this.#DEFAULT_ACK_TIMEOUT,
          retries: value.retries ?? 0,
          queuedAt: value.queuedAt ?? Date.now(),
          settle: () => {},
        });
      }
      restored.sort((a, b) => a.queuedAt - b.queuedAt);
      const liveIds = new Set(
        this.#sendQueue.map((e) => e.message?.__env?.msgId).filter(Boolean),
      );
      for (const entry of restored) {
        const msgId = entry.message?.__env?.msgId;
        if (msgId && liveIds.has(msgId)) {
          // 内存里已有同 msgId 的活条目（恢复期间新入队）：
          // 只跳过重复恢复，保留其持久化记录，否则刷新后会丢这条
          continue;
        }
        this.#sendQueue.push(entry);
      }
      while (this.#sendQueue.length > this.#QUEUE_MAX) {
        const dropped = this.#sendQueue.shift();
        dropped.settle({ status: "dropped", reason: "queue_overflow" });
        this.#unpersistEntry(dropped);
      }
      // 恢复即尝试续投：对端在线则立即补投，离线则由退避定时器接力
      if (this.#sendQueue.length > 0) {
        this.#scheduleReflush();
      }
    } catch {
      // 存储不可用（隐私模式/配额不足）：降级为纯内存队列，不影响发送
    }
  }

  /**
   * 将消息放入离线队列，返回 queued 回执。
   * 队列在服务器恢复连接 / 对端服务上线 / 退避定时器触发时经 _flushQueue 补投。
   * 入队即持久化到 nos/storage，出队（送达/过期/溢出/销毁）时移除。
   */
  #enqueueMessage(message, appId, sessionId, opts = {}) {
    const now = Date.now();
    const entry = {
      message,
      appId,
      sessionId,
      ackTimeout: opts.ackTimeout ?? this.#DEFAULT_ACK_TIMEOUT,
      retries: opts.retries ?? 0,
      queuedAt: now,
      settle: null,
    };
    const queued = {
      status: "queued",
      appId,
      sessionId: sessionId || undefined,
      msgId: message.__env.msgId,
      queuedAt: now,
    };
    defineHidden(
      queued,
      "flushed",
      new Promise((resolve) => {
        entry.settle = resolve;
      }),
    );

    this.#sendQueue.push(entry);
    this.#persistEntry(entry);
    while (this.#sendQueue.length > this.#QUEUE_MAX) {
      const dropped = this.#sendQueue.shift();
      dropped.settle({ status: "dropped", reason: "queue_overflow" });
      this.#unpersistEntry(dropped);
    }
    this.#scheduleReflush();
    return queued;
  }

  /**
   * 冲刷离线队列：逐条重新解析目标并补投（复用原信封 msgId，接收端去重兜底）。
   * 由 server_connected / rtc_state(connected) / __service_available / 退避定时器触发。
   *
   * 条目在"投递结论明确"后才算消费完成：
   * - delivered：对端核心层回 __ack 确认（handler 已执行）；旧版本对端不回
   *   __ack，退化为传输层成功即 delivered；
   * - failed：对端回确定性失败（no_handler / handler_error 等）；
   * - 传输层全部失败或 ack 超时（对端支持信封时）：塞回队首按退避重投，
   *   持久化记录保留，直至送达或 TTL 过期。
   */
  async _flushQueue() {
    if (this.#flushing) return;
    // 等持久化队列恢复完成，避免恢复前误判队列为空而跳过补投
    try {
      await this.#queueRestorePromise;
    } catch {
      // 恢复失败按当前内存队列处理
    }
    if (this.#flushing) return;
    if (this.#sendQueue.length === 0) return;
    this.#flushing = true;
    try {
      while (this.#sendQueue.length > 0) {
        const entry = this.#sendQueue[0];
        if (Date.now() - entry.queuedAt > this.#QUEUE_TTL) {
          this.#sendQueue.shift();
          this.#unpersistEntry(entry);
          entry.settle({ status: "expired", reason: "queue_ttl" });
          continue;
        }

        // 始终按 appId 重新发现目标：补投钉死在原 session 上没有意义
        //（原 session 可能已死），应用在哪个 session 活着就投到哪
        let targets = null;
        try {
          targets = await this.#resolveServiceTargets(entry.appId);
        } catch {
          targets = null;
        }
        if (!targets || targets.offline || targets.sessions.length === 0) {
          // 对端仍不可达：安排退避重试，等待下一次触发
          break;
        }
        const sessions = targets.sessions;

        // 出队但暂不删持久化记录：投递结论明确前消息必须可恢复
        this.#sendQueue.shift();
        const requeue = () => {
          this.#sendQueue.unshift(entry);
        };
        try {
          const results = await this.#deliverMessage(entry.message, sessions, {
            ackTimeout: entry.ackTimeout,
            retries: entry.retries,
            queue: false,
          });

          const settleDelivered = () => {
            this.#unpersistEntry(entry);
            this.#reflushDelay = this.#REFLUSH_BASE;
            entry.settle({ status: "delivered", results });
          };

          if (!results.some((r) => r?.delivered === true)) {
            // 全部目标投递失败（多为陈旧会话）：塞回队首等待下一次补投
            requeue();
            break;
          }

          const acked = results.map((r) => r?.acked).find(Boolean);
          if (!acked || !(entry.ackTimeout > 0)) {
            // 对端无 acked 跟踪（ackTimeout≤0 关闭）：按传输层成功结算
            settleDelivered();
            continue;
          }

          const ack = await acked;
          if (ack.confirmed) {
            // 对端核心层已执行完 handler，投递终态成立
            settleDelivered();
          } else if (ack.reason && ack.reason !== "timeout") {
            // 确定性失败（no_handler / handler_error / pull_failed）：重投无益
            this.#unpersistEntry(entry);
            entry.settle({ status: "failed", reason: ack.reason, results });
          } else if (this.#peerSupportsAck) {
            // 对端支持信封却未在超时内确认：消息可能已丢（半开 RTC 等），
            // 塞回队首重投——对端按 msgId 去重，重复投递安全
            requeue();
            break;
          } else {
            // 旧版本对端不回 __ack：无法进一步确认，按传输层成功结算
            settleDelivered();
          }
        } catch {
          // 投递过程异常：塞回队首按退避重试，TTL 兜底
          requeue();
          break;
        }
      }
    } finally {
      this.#flushing = false;
    }
    // 队列仍有残留（对端不可达）时安排退避重试
    if (this.#sendQueue.length > 0) {
      this.#scheduleReflush();
    }
  }

  /**
   * 安排一次退避重冲刷（1.5s 起指数退避，上限 30s）
   */
  #scheduleReflush() {
    if (this.#reflushTimer) return;
    this.#reflushTimer = setTimeout(() => {
      this.#reflushTimer = null;
      this._flushQueue();
    }, this.#reflushDelay);
    this.#reflushDelay = Math.min(this.#reflushDelay * 2, this.#REFLUSH_MAX);
  }

  /**
   * 兜底：向对端所有 session 广播（老行为，仅在 fallback: "broadcast" 时使用）
   */
  async #broadcastToAllSessions(appId, data, opts = {}) {
    const sessionIds = await this.getSessionIds();
    return this.#deliverToSessions(appId, data, sessionIds, {
      ...opts,
      queue: false,
    });
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
      // 对端服务上线：立即尝试补投离线队列中等待该服务的消息
      if (this.#sendQueue.length > 0) {
        this._flushQueue().catch(() => {});
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
   * send 完成后调用：记录本次 via 和 url，若路径发生变化则自动触发 ping；
   * 同时惰性启动端到端存活监视（首次通信后才需要关心对端是否还活着）
   */
  #onSendComplete(sessionId, via, url) {
    this.#ensureLivenessMonitor();
    const lastVia = this.#lastSendVia.get(sessionId);
    if (lastVia && lastVia.via !== via) {
      // 传输路径变化（server ↔ rtc），重新测量 RTT
      this.recalcRTT(sessionId);
    }
    this.#lastSendVia.set(sessionId, { via, url });
  }

  // ───── 端到端存活检测 ─────

  /**
   * 惰性启动存活监视：首次成功发送后开启，每 25s 检查一轮
   */
  #ensureLivenessMonitor() {
    if (this.#livenessTimer || this.#disposed) return;
    this.#livenessTimer = setInterval(() => {
      this._checkLiveness().catch(() => {});
    }, this.#LIVENESS_INTERVAL);
  }

  /**
   * 执行一轮存活检测（内部接口，供测试与定时器调用）：
   * 对已建立过通信的 session 逐个 ping（全路径 echo），
   * 检测死亡/复活转换：
   * - 死亡：主动失效该 session 的服务发现缓存（防幽灵投递）；
   * - 转换时触发 LocalUser 级 `liveness_change` 事件。
   */
  async _checkLiveness() {
    if (this.#disposed) return;
    // 只检测已建立过通信的 session（sendCounts 的键），避免为陌生用户空转
    const known = [...this.#sendCounts.keys()];
    for (const sessionId of known) {
      if (this.#disposed) return;
      let alive = false;
      try {
        await this.ping(sessionId);
        alive = true;
      } catch {
        alive = false;
      }
      const prev = this.#lastLiveness.get(sessionId);
      if (prev === alive) continue;

      this.#lastLiveness.set(sessionId, alive);
      if (!alive) {
        // 主动失效该 session 的服务发现缓存，让服务发现重新查询，
        // 而不是把消息投给一个可能已死的会话
        for (const [appId, cached] of this.#serviceSessionCache) {
          if (cached.sessions.includes(sessionId)) {
            this.#invalidateServiceSession(appId, sessionId);
          }
        }
      }
      this.#localUser._trigger("liveness_change", {
        userId: this.#userId,
        sessionId,
        alive,
      });
    }
  }

  /**
   * 查询指定 session 的最近一次端到端存活检测结果。
   * @param {string} sessionId
   * @returns {boolean|null} true=存活 / false=死亡 / null=尚未检测
   */
  getLiveness(sessionId) {
    return this.#lastLiveness.get(sessionId) ?? null;
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
}
