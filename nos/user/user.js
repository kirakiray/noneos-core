import { BaseUser } from "./base-user.js";
import {
  getUserKeys,
  saveUserKeys,
  saveUserInfo,
  getUserInfo,
  addUserStorageId,
  addSharedStorage,
  removeSharedStorage,
} from "./db.js";
import { getStorage as getGlobalStorage } from "../storage/main.js";
import { generateKeyPair } from "../crypto/crypto-ecdsa.js";
import { CertManager } from "./cert.js";
import { CardManager } from "./card.js";
import { ServerManager } from "./server.js";
import { RemoteUser } from "./remote-user.js";
import { RTCManager } from "./rtc.js";
import { ServiceRegistry } from "./service-registry.js";
import { TrafficLogger, inferCategory, measureSize } from "./traffic.js";

// 全局初始化 Promise 缓存，防止同一 namespace 并发初始化
const initPromises = new Map();

/**
 * 本地用户类，继承自 BaseUser
 * 根据传入的命名空间在 IndexedDB 中管理公钥和私钥
 */
export class LocalUser extends BaseUser {
  #namespace;
  #sessionId = "s-" + Math.random().toString(36).substring(2, 10);
  #cert;
  #card;
  #server;
  #rtc;
  #sessionChannel;
  #remoteUserCache = new Map(); // userId -> Promise<RemoteUser> | RemoteUser
  #serviceRegistry;
  #traffic;

  /**
   * 构造函数
   * @param {string} namespace - 用户空间的命名
   */
  constructor(namespace) {
    super(); // 初始化父类，由于我们修改了 BaseUser，可以不传 publicKey
    if (!namespace) {
      throw new Error("namespace is required");
    }
    this.#namespace = namespace;
    this.#cert = new CertManager(this);
    this.#card = new CardManager(this);
    this.#server = new ServerManager(this);
    this.#rtc = new RTCManager(this);
    this.#serviceRegistry = new ServiceRegistry(this);
    this.#traffic = new TrafficLogger(this);
    // 创建持久化的 BroadcastChannel 监听跨标签页 session 查询
    this.#sessionChannel = new BroadcastChannel(`noneos-sessions-${namespace}`);
    this.#sessionChannel.addEventListener("message", (event) => {
      if (event.data.type === "session-announce") {
        // 其他标签页请求广播，回复自己的 sessionId
        this.#sessionChannel.postMessage({
          type: "session-response",
          sessionId: this.#sessionId,
        });
      }
    });

    // 设置 RTC 直连消息并分发给对应的 RemoteUser 实例
    this.#setupRTCDispatch();
    // 监听 relay 消息并分发给对应的 RemoteUser 实例
    this.#setupRelayDispatch();
    // 监听 RTC 建立/断开事件，触发对应 RemoteUser 重新测量 RTT
    this.#setupRTCStateListener();
  }

  /**
   * 设置 relay 消息分发：当本地用户收到 relay 消息时，
   * 解析后分发给缓存的 RemoteUser 实例。
   *
   * 支持两种 relay 格式：
   * - 文本 relay：JSON 格式，用于明文消息和内部协议（名片等）
   * - 二进制 relay：帧格式 [4B header_len][header JSON][payload]，用于 E2EE 加密数据
   *
   * E2EE 数据自动尝试解密，解密失败则透传原始 Uint8Array。
   */
  #setupRelayDispatch() {
    this.bind("message", (event) => {
      const detail = event.detail;
      // 入站流量埋点：服务器中继（含握手挑战、latency、relay 等所有 WS 文本/二进制）
      this.#recordInboundFromServer(detail);
      if (typeof detail.data === "string") {
        this.#handleTextRelay(detail, event);
      } else {
        this.#handleBinaryRelay(detail);
      }
    });
  }

  /**
   * 记录来自 WebSocket 服务器的入站流量元数据
   */
  #recordInboundFromServer(detail) {
    try {
      const url = detail.url || "";
      const size = measureSize(detail.data);
      let parsed = null;
      let peerUserId = "";
      let sessionId = "";
      if (typeof detail.data === "string") {
        try {
          parsed = JSON.parse(detail.data);
        } catch {
          parsed = null;
        }
        if (parsed && typeof parsed === "object") {
          // relay 消息内含 from_user_id/from_session_id
          if (parsed.type === "relay") {
            peerUserId = parsed.from_user_id || "";
            sessionId = parsed.from_session_id || "";
            const inner = parsed.data;
            const info = inferCategory(inner);
            this.#traffic.record({
              direction: "in",
              via: "server",
              serverUrl: url,
              peerUserId,
              sessionId,
              size,
              category: info.category,
              messageType: info.messageType,
              appId: info.appId,
              success: true,
            });
            return;
          }
          const info = inferCategory(parsed);
          this.#traffic.record({
            direction: "in",
            via: "server",
            serverUrl: url,
            peerUserId: "",
            sessionId: "",
            size,
            category: info.category,
            messageType: info.messageType,
            appId: info.appId,
            success: true,
          });
          return;
        }
      }
      // 二进制帧：尝试解析 header 获取 peerUserId/appId
      let category = "relay";
      let messageType = "relay";
      let appId = "";
      if (detail.data instanceof ArrayBuffer || ArrayBuffer.isView(detail.data)) {
        const buf =
          detail.data instanceof ArrayBuffer
            ? detail.data
            : detail.data.buffer.slice(
                detail.data.byteOffset,
                detail.data.byteOffset + detail.data.byteLength,
              );
        try {
          if (buf.byteLength >= 4) {
            const view = new DataView(buf);
            const headerLen = view.getUint32(0, false);
            if (4 + headerLen <= buf.byteLength) {
              const headerBytes = new Uint8Array(buf, 4, headerLen);
              const header = JSON.parse(new TextDecoder().decode(headerBytes));
              if (header && typeof header === "object") {
                peerUserId = header.from_user_id || "";
                sessionId = header.from_session_id || "";
                if (header.__app) {
                  category = "app";
                  messageType = "__app";
                  appId = header.__app;
                }
              }
            }
          }
        } catch {
          // 解析失败保持 relay
        }
      }
      this.#traffic.record({
        direction: "in",
        via: "server",
        serverUrl: url,
        peerUserId,
        sessionId,
        size,
        category,
        messageType,
        appId,
        success: true,
      });
    } catch (err) {
      // 记录失败不影响业务
      console.warn("[TrafficLogger] record inbound server failed:", err);
    }
  }

  /**
   * 处理文本 relay 消息（明文或内部协议）
   */
  #handleTextRelay(detail, event) {
    let parsed;
    try {
      parsed = JSON.parse(detail.data);
    } catch {
      return;
    }
    if (parsed.type !== "relay") return;
    const fromUserId = parsed.from_user_id;
    if (!fromUserId) return;

    // 拦截 RTC 信令，交由 RTCManager 处理，不透传给 RemoteUser
    // 同时阻止外部 message 监听器收到内部信令
    if (parsed.data?.type === "rtc_signal") {
      console.log(
        `[LocalUser] rtc_signal recv: from=${fromUserId}:${parsed.from_session_id}, signalType=${parsed.data.signal?.type}`,
      );
      event.stopImmediatePropagation();
      this.#rtc.handleSignal(
        fromUserId,
        parsed.from_session_id,
        parsed.data.signal,
      );
      return;
    }

    this.#dispatchToRemote(fromUserId, parsed.from_session_id, parsed.data, detail.url);
  }

  /**
   * 设置 RTC 直连消息分发：收到 DataChannel 消息后，
   * 尝试 E2EE 解密，然后分发给对应的 RemoteUser 实例。
   */
  #setupRTCDispatch() {
    this.bind("rtc_message", async (event) => {
      const { fromUserId, fromSessionId, data } = event.detail;
      // 入站流量埋点：RTC DataChannel（记录链路字节数，加密后）
      try {
        const size = measureSize(data);
        let category = "relay";
        let messageType = "relay";
        let appId = "";
        if (typeof data === "string") {
          try {
            const parsed = JSON.parse(data);
            const info = inferCategory(parsed);
            category = info.category;
            messageType = info.messageType;
            appId = info.appId;
          } catch {
            // 非 JSON 文本
          }
        }
        this.#traffic.record({
          direction: "in",
          via: "rtc",
          serverUrl: "",
          peerUserId: fromUserId || "",
          sessionId: fromSessionId || "",
          size,
          category,
          messageType,
          appId,
          success: true,
        });
      } catch {
        // 记录失败静默
      }

      let messageData = data;

      if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
        const buffer =
          data instanceof ArrayBuffer
            ? new Uint8Array(data)
            : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

        if (buffer.byteLength > 12) {
          try {
            const { tryDecryptBinary } = await import(
              "../../crypto/crypto-e2ee.js"
            );
            const decrypted = await tryDecryptBinary(
              this,
              fromUserId,
              buffer,
            );
            if (decrypted !== null) {
              messageData = decrypted;
            }
          } catch {
            // 解密失败，透传原始数据
          }
        }
      }

      // RTC DataChannel 传输的未加密消息为 JSON 字符串，
      // 需要 parse 成对象后才能被 #dispatchToRemote 正确路由（如 __app 分发）
      if (typeof messageData === "string") {
        try {
          messageData = JSON.parse(messageData);
        } catch {
          // 非 JSON 文本，保持原样透传
        }
      }

      this.#dispatchToRemote(fromUserId, fromSessionId, messageData, "rtc");
    });
  }

  /**
   * 监听 RTC 状态变化：
   * - connected：DataChannel 建立，重新测量 RTT
   * - disconnected：DataChannel/PC 断开，清理 RemoteUser 的重连标记与冷却，
   *   使下一次 send() 能重新发起 RTC 配对（避免刷新/抖动后永久走服务端中转）
   */
  #setupRTCStateListener() {
    this.bind("rtc_state", (event) => {
      const { userId, sessionId, state } = event.detail;
      console.log(
        `[LocalUser] rtc_state event: userId=${userId}, sessionId=${sessionId}, state=${state}, hasRemoteUser=${this.#remoteUserCache.has(userId)}`,
      );
      if (!this.#remoteUserCache.has(userId)) return;
      Promise.resolve(this.#remoteUserCache.get(userId))
        .then((remoteUser) => {
          if (state === "disconnected") {
            remoteUser._handleRTCStateChange(sessionId, "disconnected");
          }
          // connected / disconnected 都重测 RTT：
          // connected → 测新路径；disconnected → ping 自动回落到 server 路径
          remoteUser.recalcRTT(sessionId);
        })
        .catch((err) => {
          console.warn(
            `[LocalUser] rtc_state handler failed: userId=${userId}, sessionId=${sessionId}`,
            err,
          );
        });
    });
  }

  /**
   * 处理二进制 relay 帧
   *
   * 帧格式：[4B header_len(u32 BE)][header JSON][payload bytes]
   * 如果 payload 是 E2EE 格式（长度 > 12），自动尝试解密。
   */
  async #handleBinaryRelay(detail) {
    let buffer;
    try {
      buffer = detail.data instanceof Blob ? await detail.data.arrayBuffer() : detail.data;
    } catch {
      return;
    }

    if (buffer.byteLength < 4) return;
    const view = new DataView(buffer);
    const headerLen = view.getUint32(0, false); // BE

    if (4 + headerLen > buffer.byteLength) return;

    let header;
    try {
      const headerBytes = new Uint8Array(buffer, 4, headerLen);
      header = JSON.parse(new TextDecoder().decode(headerBytes));
    } catch {
      return;
    }

    if (header.type !== "relay") return;
    const fromUserId = header.from_user_id;
    if (!fromUserId) return;

    // 提取 payload 字节
    const payload = new Uint8Array(buffer, 4 + headerLen);

    // 尝试 E2EE 解密
    let messageData = payload;
    if (payload.byteLength > 12) {
      try {
        const { tryDecryptBinary } = await import("../crypto/crypto-e2ee.js");
        const decrypted = await tryDecryptBinary(this, fromUserId, payload);
        if (decrypted !== null) {
          messageData = decrypted;
        }
      } catch {
        // 解密失败，透传原始 payload
      }
    }

    this.#dispatchToRemote(fromUserId, header.from_session_id, messageData, detail.url);
  }

  /**
   * 将消息分发给相应的处理器
   *
   * 分发优先级：
   * 1. 若消息 type 为 __service_query → LocalUser 级别处理（回复 service 列表）
   * 2. 若消息 type 为 __service_available / __service_unavailable → 更新对端 RemoteUser 的服务缓存
   * 3. 若消息包含 __app 字段 → 分发给 ServiceRegistry 中对应的 handler
   * 4. 否则 → 分发给缓存的 RemoteUser 实例
   */
  #dispatchToRemote(fromUserId, fromSessionId, messageData, viaServer) {
    // 1. 检查是否为 __service 发现协议消息（任何用户都可能发起，无需缓存）
    if (messageData && typeof messageData === "object" && messageData.type === "__service_query") {
      this.#handleServiceQuery(fromUserId, fromSessionId, messageData);
      return;
    }

    // 2. 检查是否为 __service_available / __service_unavailable 主动广播
    if (
      messageData &&
      typeof messageData === "object" &&
      (messageData.type === "__service_available" ||
        messageData.type === "__service_unavailable")
    ) {
      this.#handleServiceAvailability(
        fromUserId,
        fromSessionId,
        messageData.appId,
        messageData.type === "__service_available",
      );
      return;
    }

    // 3. 检查是否为 app 绑定消息
    if (
      messageData &&
      typeof messageData === "object" &&
      !Array.isArray(messageData) &&
      messageData.__app
    ) {
      this.#dispatchToServiceApp(fromUserId, fromSessionId, messageData);
      return;
    }

    // 4. 确保 RemoteUser 存在后分发给对应实例
    this.#ensureRemoteUser(fromUserId, "remote")
      .then((remoteUser) => {
        remoteUser._trigger("message", {
          fromUserId,
          fromSessionId,
          data: messageData,
          viaServer,
        });
      })
      .catch(() => {});
  }

  /**
   * 处理对端主动广播的服务上/下线消息，
   * 更新对应 RemoteUser 的 serviceSessionCache 并唤醒等待者
   */
  async #handleServiceAvailability(fromUserId, fromSessionId, appId, available) {
    if (!appId) return;
    try {
      const remoteUser = await this.#ensureRemoteUser(fromUserId, "remote");
      remoteUser._handleServiceAvailability(appId, fromSessionId, available);
    } catch {
      // 无法建立 RemoteUser 时静默丢弃
    }
  }

  /**
   * 响应对方发起的 service 查询：回复本地所有已注册 appId 列表
   * 通过缓存的 RemoteUser 发送回复，确保路径一致
   */
  async #handleServiceQuery(fromUserId, fromSessionId, query) {
    const services = this.#serviceRegistry.getServiceList();
    try {
      const remoteUser = await this.#ensureRemoteUser(fromUserId, "remote");
      await remoteUser.send(fromSessionId, {
        type: "__service_response",
        id: query.id,
        services,
      }, true); // raw=true 跳过 E2EE
    } catch {
      // 失败静默
    }
  }

  /**
   * 将 __app 消息分发给 ServiceRegistry 中注册的 handler
   *
   * 未注册对应 appId 时不会直接丢弃业务信息，而是触发本地
   * `unhandled_service_message` 事件供调试/兜底逻辑使用。
   */
  async #dispatchToServiceApp(fromUserId, fromSessionId, messageData) {
    const appId = messageData.__app;
    const data = messageData.__data;
    const handler = this.#serviceRegistry.getHandler(appId);
    if (!handler) {
      // 触发本地事件，便于观测并支持业务侧兜底处理
      this._trigger("unhandled_service_message", {
        appId,
        fromUserId,
        fromSessionId,
        data,
      });
      return;
    }

    // 获取或创建 RemoteUser 供 ctx 使用
    const remoteUser = await this.#ensureRemoteUser(fromUserId, "remote");

    const ctx = {
      fromUserId,
      fromSessionId,
      remoteUser,
    };

    try {
      handler(data, ctx);
    } catch (err) {
      console.warn(`[ServiceRegistry] Handler error for "${appId}":`, err);
    }
  }

  /**
   * 获取用户的命名空间
   */
  get namespace() {
    return this.#namespace;
  }

  /**
   * 获取会话 ID
   */
  get sessionId() {
    return this.#sessionId;
  }

  /**
   * 获取证书管理器
   */
  get cert() {
    return this.#cert;
  }

  /**
   * 获取名片管理器
   */
  get card() {
    return this.#card;
  }

  /**
   * 获取服务器管理器
   */
  get server() {
    return this.#server;
  }

  /**
   * 获取 RTC 管理器
   */
  get rtc() {
    return this.#rtc;
  }

  /**
   * 获取流量记录器
   */
  get traffic() {
    return this.#traffic;
  }

  /**
   * 获取当前已连接成功的 RemoteUser 列表
   * 包含主动 connectUser 成功的用户，以及收到消息后被动创建 RemoteUser 的用户
   * 返回数组快照，避免外部修改内部缓存
   * @returns {RemoteUser[]}
   */
  get remoteUsers() {
    const users = [];
    for (const entry of this.#remoteUserCache.values()) {
      if (entry instanceof RemoteUser) {
        users.push(entry);
      }
    }
    return Object.freeze(users);
  }

  /**
   * 注册一个应用服务
   *
   * 注册后，对方可以通过 remoteUser.sendToService(appId, data) 发送数据，
   * 收到的消息会自动路由到 onMessage 回调。
   *
   * @param {string} appId - 应用唯一标识
   * @param {Object} [options]
   * @param {boolean} [options.exposeToServer=false] - 是否将 appId 暴露给服务端
   * @param {Function} [options.onMessage] - (data, ctx) => {} 收到的应用消息
   * @returns {{ appId: string, unregister: () => void }}
   */
  registerService(appId, options = {}) {
    return this.#serviceRegistry.register(appId, options);
  }

  /**
   * 准备用户实例，从数据库获取密钥对，如果不存在则生成并保存
   * 使用 Promise 缓存防止并发初始化导致密钥不一致
   * @returns {Promise}
   */
  async ready() {
    if (this.userId) {
      return this;
    }

    // 检查是否已有该 namespace 的初始化 Promise
    let initPromise = initPromises.get(this.#namespace);

    if (!initPromise) {
      // 创建新的初始化 Promise
      initPromise = (async () => {
        let keys = await getUserKeys(this.#namespace);
        let isNewUser = false;
        if (!keys) {
          // 数据库中没有密钥，生成新的密钥对
          keys = await generateKeyPair();
          await saveUserKeys(this.#namespace, keys);
          isNewUser = true;
        }
        return { keys, isNewUser };
      })();

      initPromises.set(this.#namespace, initPromise);

      // 初始化完成后清理缓存，允许后续重新初始化
      initPromise.finally(() => {
        initPromises.delete(this.#namespace);
      });
    }

    // 等待初始化完成并获取密钥
    const { keys, isNewUser } = await initPromise;

    // 调用父类的 init 以完成其余的初始化逻辑（如计算哈希、生成签名/验证函数等）
    await super.init(keys);

    // 如果是新用户，生成默认用户名并保存
    if (isNewUser) {
      const defaultUsername =
        "user-" + Math.random().toString(36).substring(2, 10);
      await this.updateInfo({ username: defaultUsername });
    }

    // 启动名片监听
    this.#card.start();

    // 自动连接默认服务器列表，不阻塞 ready()
    this.#server.connectAll().catch(() => {});

    return this;
  }

  /**
   * 获取该用户专属的存储空间
   *
   * 底层复用 nos/storage，存储 id 为 `user:<namespace>:<userId>:<name>`，
   * 每个「本地用户 + 身份 + 子空间」对应独立的 IndexedDB 数据库，天然隔离：
   * 不同用户、同一用户不同身份之间互不可见。
   *
   * 创建时会自动登记到用户库，deleteUser 时联动清理。
   * @param {string} [name] - 业务子空间名，默认 "default"
   * @returns {Promise<NosStorage>}
   */
  async getStorage(name = "default") {
    await this.ready();
    const id = `user:${this.#namespace}:${this.userId}:${name}`;
    await addUserStorageId(this.#namespace, id);
    return getGlobalStorage(id);
  }

  /**
   * 显式开启一个存储空间的共享（只读），供远端用户读取。
   *
   * 仅允许以 `share:` 开头的子空间名参与共享，其余存储不会被远端访问；
   * 开启后所有已连接用户都能读取该空间，返回的 revoke 函数可随时关闭共享。
   *
   * 注意：共享的是「读取」能力，远端无法写入；本方法不创建存储，
   * 数据仍由本地 getStorage("share:xxx") 维护。
   *
   * @param {string} name - 存储空间名，必须以 "share:" 开头
   * @returns {Promise<() => Promise<void>>} revoke 函数：调用后关闭该空间的共享
   */
  async shareStorage(name) {
    await this.ready();
    if (!name || !name.startsWith("share:")) {
      throw new Error('shareStorage name must start with "share:"');
    }
    await addSharedStorage(this.#namespace, name);
    return async () => {
      await removeSharedStorage(this.#namespace, name);
    };
  }

  /**
   * 更新用户信息
   * 合并现有信息，签名后存储到数据库
   * @param {Object} data - 需要更新的用户信息字段
   * @returns {Promise<Object>} 更新后的签名用户信息
   */
  async updateInfo(data) {
    // 获取现有信息
    const existingInfo = (await getUserInfo(this.#namespace)) || {};

    // 合并数据，移除签名相关字段后重新签名
    const { signTime, publicKey, signature, ...pureExistingInfo } =
      existingInfo;
    const mergedData = { ...pureExistingInfo, ...data, userId: this.userId };

    // 签名数据
    const signedData = await this._sign(mergedData);

    // 保存到数据库
    await saveUserInfo(this.#namespace, signedData);

    return signedData;
  }

  /**
   * 获取用户信息
   * @returns {Promise<Object | null>} 已签名的用户信息
   */
  async getInfo() {
    return getUserInfo(this.#namespace);
  }

  /**
   * 确保指定 userId 已创建 RemoteUser 并加入缓存。
   * 如果是新加入的，触发 remote_user_connected 事件。
   * @param {string} userId
   * @param {"local"|"remote"} initiatedBy
   * @returns {Promise<RemoteUser>}
   */
  #ensureRemoteUser(userId, initiatedBy = "remote") {
    if (this.#remoteUserCache.has(userId)) {
      return Promise.resolve(this.#remoteUserCache.get(userId));
    }

    const remoteUser = new RemoteUser(userId, this);
    this.#remoteUserCache.set(userId, remoteUser);
    this.#triggerRemoteUserConnected(userId, remoteUser, initiatedBy);
    return Promise.resolve(remoteUser);
  }

  /**
   * 内部接口：供管理器确保 RemoteUser 存在。
   * @param {string} userId
   * @param {"local"|"remote"} initiatedBy
   * @returns {Promise<RemoteUser>}
   */
  _ensureRemoteUser(userId, initiatedBy = "remote") {
    return this.#ensureRemoteUser(userId, initiatedBy);
  }

  #triggerRemoteUserConnected(userId, remoteUser, initiatedBy) {
    this._trigger("remote_user_connected", {
      userId,
      remoteUser,
      initiatedBy,
    });
  }

  #triggerRemoteUserDisconnected(userId, remoteUser, reason, error) {
    this._trigger("remote_user_disconnected", {
      userId,
      remoteUser,
      reason,
      error,
    });
  }

  /**
   * 连接远程用户，返回对应的 RemoteUser 实例
   * 会查询已连接的服务器确认对方是否在线
   * @param {string} userId - 目标用户的 userId
   * @returns {Promise<RemoteUser>}
   */
  async connectUser(userId) {
    if (!userId) {
      throw new Error("userId is required");
    }

    // 已有缓存（进行中的 Promise 或已完成的 RemoteUser）
    if (this.#remoteUserCache.has(userId)) {
      return this.#remoteUserCache.get(userId);
    }

    // 发起连接，Promise 存入缓存，并发调用复用同一 Promise
    const promise = this.#doConnectUser(userId)
      .then((remoteUser) => {
        if (this.#remoteUserCache.get(userId) === promise) {
          this.#remoteUserCache.set(userId, remoteUser);
          this.#triggerRemoteUserConnected(userId, remoteUser, "local");
        }
        return remoteUser;
      })
      .catch((error) => {
        if (this.#remoteUserCache.get(userId) === promise) {
          this.#remoteUserCache.delete(userId);
          this.#triggerRemoteUserDisconnected(userId, null, "error", error);
        }
        throw new Error(`User ${userId} is not online on any connected server`);
      });

    this.#remoteUserCache.set(userId, promise);
    return promise;
  }

  async #doConnectUser(userId) {
    // 使用共享算法查询目标用户在线的服务器（按综合延迟排序）
    // 因并发握手/状态同步可能存在短暂窗口，这里做少量重试
    let bestServer = null;
    const maxRetries = 5;
    for (let i = 0; i < maxRetries; i++) {
      bestServer = await this.#server.findBestServer(userId);
      if (bestServer) break;
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    if (!bestServer) {
      throw new Error(`User ${userId} is not online on any connected server`);
    }
    const remoteUser = new RemoteUser(userId, this);
    return remoteUser;
  }

  /**
   * 断开与远程用户的连接
   * 清理本地缓存并触发 remote_user_disconnected 事件
   * @param {string} userId - 目标用户的 userId
   */
  async disconnectUser(userId) {
    const cached = this.#remoteUserCache.get(userId);
    if (!cached) return;

    const remoteUser = await Promise.resolve(cached).catch(() => null);
    this.#remoteUserCache.delete(userId);
    if (remoteUser) {
      // 先 dispose RemoteUser（清内部状态/定时器），再断底层 PC 资源
      // 顺序：dispose 不依赖 PC；disconnectAllForUser 触发的 rtc_state(disconnected)
      // 回调到已 dispose 的 RemoteUser 时 _handleRTCStateChange 仍是安全的（只做 delete）
      remoteUser.dispose();
      this.#rtc.disconnectAllForUser(userId);
      this.#triggerRemoteUserDisconnected(userId, remoteUser, "manual");
    } else {
      // remoteUser 为 null（之前连接失败），仍需清理可能残留的 PC 资源
      this.#rtc.disconnectAllForUser(userId);
    }
  }

  /**
   * 查询指定 userId 当前是否在线
   * 已缓存用户通过 RemoteUser.getSessionIds() 判断；未缓存用户直接查询已连接服务器
   * @param {string} userId - 目标用户的 userId
   * @returns {Promise<boolean>}
   */
  async isRemoteUserOnline(userId) {
    if (!userId) {
      throw new Error("userId is required");
    }

    if (this.#remoteUserCache.has(userId)) {
      const remoteUser = await Promise.resolve(this.#remoteUserCache.get(userId));
      const sessions = await remoteUser.getSessionIds();
      return sessions.length > 0;
    }

    const urls = this.#server.connectedUrls;
    for (const url of urls) {
      try {
        const result = await this.#server.queryUserOnline(url, userId);
        if (result.online) return true;
      } catch {
        // 继续尝试其他服务器
      }
    }
    return false;
  }

  /**
   * 获取当前已缓存的 RemoteUser 列表
   * @param {Object} [options]
   * @param {boolean} [options.onlineOnly=false] - 为 true 时过滤掉当前不在线的用户
   * @returns {Promise<RemoteUser[]>}
   */
  async getRemoteUsers(options = {}) {
    const { onlineOnly = false } = options || {};
    const users = this.remoteUsers;
    if (!onlineOnly) return users.slice();

    const results = await Promise.allSettled(
      users.map(async (remoteUser) => {
        const sessions = await remoteUser.getSessionIds();
        return sessions.length > 0 ? remoteUser : null;
      }),
    );

    return results
      .filter((r) => r.status === "fulfilled" && r.value)
      .map((r) => r.value);
  }

  /**
   * 获取同一 namespace 下所有标签页的 sessionId 列表
   * 通过 BroadcastChannel 实现跨标签页通信，无需经过服务器
   * 每个 LocalUser 实例在构造时已注册持久化监听器，会自动回复其他实例的查询
   * @param {number} [timeout=100] - 等待其他标签页响应的超时时间（毫秒）
   * @returns {Promise<string[]>} 包含自身在内的所有活跃 sessionId 列表
   */
  async getSessionIds(timeout = 1000) {
    return new Promise((resolve) => {
      const sessions = new Set();
      // 包含自己的 sessionId
      sessions.add(this.#sessionId);

      const handler = (event) => {
        if (event.data.type === "session-response") {
          // 收集其他标签页的 sessionId
          sessions.add(event.data.sessionId);
        }
      };

      this.#sessionChannel.addEventListener("message", handler);

      // 广播 announce，询问其他标签页
      this.#sessionChannel.postMessage({ type: "session-announce" });

      // 超时后返回收集到的结果
      setTimeout(() => {
        this.#sessionChannel.removeEventListener("message", handler);
        resolve([...sessions]);
      }, timeout);
    });
  }
}
