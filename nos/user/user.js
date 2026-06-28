import { BaseUser } from "./base-user.js";
import { getUserKeys, saveUserKeys, saveUserInfo, getUserInfo } from "./db.js";
import { generateKeyPair } from "../crypto/crypto-ecdsa.js";
import { CertManager } from "./cert.js";
import { CardManager } from "./card.js";
import { ServerManager } from "./server.js";
import { RemoteUser } from "./remote-user.js";
import { RTCManager } from "./rtc.js";
import { ServiceRegistry } from "./service-registry.js";

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
  #remoteUserCache = new Map(); // userId -> Promise<RemoteUser>
  #serviceRegistry;

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
    // 监听服务器的 session_server_left 通知，聚合后触发 session_left 事件
    // 必须在 setupRelayDispatch 之前注册，确保优先拦截
    this.#setupServerNotificationDispatch();
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
      if (typeof detail.data === "string") {
        this.#handleTextRelay(detail, event);
      } else {
        this.#handleBinaryRelay(detail);
      }
    });
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

      this.#dispatchToRemote(fromUserId, fromSessionId, messageData, "rtc");
    });
  }

  /**
   * 监听 RTC 状态变化：DataChannel 建立或断开时，
   * 通知缓存的 RemoteUser 实例重新测量该 session 的 RTT。
   */
  #setupRTCStateListener() {
    this.bind("rtc_state", (event) => {
      const { userId, sessionId } = event.detail;
      if (!this.#remoteUserCache.has(userId)) return;
      Promise.resolve(this.#remoteUserCache.get(userId))
        .then((remoteUser) => remoteUser.recalcRTT(sessionId))
        .catch(() => {});
    });
  }

  /**
   * 监听服务端推送的 session_server_left 通知。
   * 当收到的消息 type 为 session_server_left 时，拦截并做聚合决策：
   * 1. 查其他已连接服务器上该 session 是否还在
   * 2. 查 RTC DataChannel 是否还连通
   * 只有所有链路都不通时才触发 session_left 事件
   *
   * 同时会触发 session_server_left 事件（在聚合前），
   * 让外部监听者可以感知某台服务器上特定 session 已断开。
   */
  #setupServerNotificationDispatch() {
    this.bind("message", (event) => {
      const detail = event.detail;
      if (typeof detail.data !== "string") return;
      let parsed;
      try {
        parsed = JSON.parse(detail.data);
      } catch {
        return;
      }
      if (parsed.type === "session_server_left") {
        event.stopImmediatePropagation();
        // 先触发 per-server 事件（聚合前），带上服务器 URL 和 session 信息
        this._trigger("session_server_left", {
          url: detail.url,
          userId: parsed.user_id,
          sessionId: parsed.session_id,
          username: parsed.username || "",
        });
        // fire-and-forget，但必须 catch 未捕获异常，防止 session_left 事件链静默断裂
        this.#handleSessionServerLeft(parsed).catch((err) => {
          console.warn(
            "[User] session_server_left handler failed:",
            err,
          );
        });
      }
    });
  }

  /**
   * 收到 session_server_left 通知后，聚合判断是否真的下线
   */
  async #handleSessionServerLeft(data) {
    const { user_id, session_id, username } = data;
    const reallyOffline = await this.#checkSessionReallyOffline(
      user_id,
      session_id,
    );
    if (reallyOffline) {
      this._trigger("session_left", {
        userId: user_id,
        sessionId: session_id,
        username: username || "",
      });
      this.#dispatchSessionLeftToRemote(user_id, session_id, username || "");
    }
  }

  /**
   * 检查指定 userId 的 sessionId 是否在其他服务器或 RTC 上仍在线
   *
   * 在慢速机器上，服务器端状态变更可能尚未完全传播到查询路径，
   * 因此当第一次查询全部返回 online 时，会进行一次短延迟重试。
   *
   * @returns {Promise<boolean>} true 表示真的下线了，false 表示还在
   */
  async #checkSessionReallyOffline(userId, sessionId) {
    // 最多尝试 2 次，覆盖服务器状态传播延迟
    for (let attempt = 0; attempt < 2; attempt++) {
      const urls = this.#server.connectedUrls;
      let anyFoundOnline = false;

      for (const url of urls) {
        try {
          const result = await this.#server.queryUserOnline(url, userId);
          if (result.online && result.sessions.includes(sessionId)) {
            anyFoundOnline = true;
            // 继续检查其他服务器（可能这个服务器上已下线，但其他服务器还在）
          }
        } catch {
          // 查询失败的服务器跳过
        }
      }

      // 只要有一个服务器上该 session 被确认还在线，说明未真正下线
      if (anyFoundOnline) {
        return false;
      }

      // 第一次查询全部未找到，但可能是服务器状态的短暂窗口
      // 等待一小段时间后重试，兼顾慢速 CI 机器
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    // 2. 检查 RTC DataChannel 是否还连通
    const dc = this.#rtc.getChannel(userId, sessionId);
    if (dc && dc.readyState === "open") {
      return false; // RTC 还通着
    }

    return true; // 所有链路都不通，真的下线了
  }

  /**
   * 将 session_left 事件分发给缓存的 RemoteUser 实例
   */
  #dispatchSessionLeftToRemote(userId, sessionId, username) {
    if (!this.#remoteUserCache.has(userId)) return;
    const remoteUserPromise = this.#remoteUserCache.get(userId);
    Promise.resolve(remoteUserPromise).then((remoteUser) => {
      remoteUser._trigger("session_left", {
        sessionId,
        username,
      });
    });
  }

  /**
   * 向所有已连接服务器注册关注（watch）指定 userId 的下线通知
   */
  async #watchUser(userId) {
    for (const url of this.#server.connectedUrls) {
      try {
        this.#server.sendToServer(
          url,
          JSON.stringify({
            type: "watch_user",
            target_user_id: userId,
          }),
        );
      } catch {
        // 发送失败的服务器跳过
      }
    }
  }

  /**
   * 向所有已连接服务器取消关注（unwatch）指定 userId 的下线通知
   */
  async #unwatchUser(userId) {
    for (const url of this.#server.connectedUrls) {
      try {
        this.#server.sendToServer(
          url,
          JSON.stringify({
            type: "unwatch_user",
            target_user_id: userId,
          }),
        );
      } catch {
        // 发送失败的服务器跳过
      }
    }
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
   * 1. 若消息包含 __app 字段 → 分发给 ServiceRegistry 中对应的 handler
   * 2. 若消息 type 为 __service_query → LocalUser 级别处理（回复 service 列表）
   * 3. 否则 → 分发给缓存的 RemoteUser 实例
   */
  #dispatchToRemote(fromUserId, fromSessionId, messageData, viaServer) {
    // 1. 检查是否为 __service 发现协议消息（任何用户都可能发起，无需缓存）
    if (messageData && typeof messageData === "object" && messageData.type === "__service_query") {
      this.#handleServiceQuery(fromUserId, fromSessionId, messageData);
      return;
    }

    // 2. 检查是否为 app 绑定消息
    if (
      messageData &&
      typeof messageData === "object" &&
      !Array.isArray(messageData) &&
      messageData.__app
    ) {
      this.#dispatchToServiceApp(fromUserId, fromSessionId, messageData, viaServer);
      return;
    }

    // 3. 分发给已缓存的 RemoteUser
    if (!this.#remoteUserCache.has(fromUserId)) return;

    const remoteUserPromise = this.#remoteUserCache.get(fromUserId);
    Promise.resolve(remoteUserPromise).then((remoteUser) => {
      remoteUser._trigger("message", {
        fromUserId,
        fromSessionId,
        data: messageData,
        viaServer,
      });
    });
  }

  /**
   * 响应对方发起的 service 查询：回复本地所有已注册 appId 列表
   * 通过缓存的 RemoteUser 发送回复，确保路径一致
   */
  async #handleServiceQuery(fromUserId, fromSessionId, query) {
    const services = this.#serviceRegistry.getServiceList();
    try {
      if (this.#remoteUserCache.has(fromUserId)) {
        const remoteUser = await this.#remoteUserCache.get(fromUserId);
        await remoteUser.send(fromSessionId, {
          type: "__service_response",
          id: query.id,
          services,
        }, true); // raw=true 跳过 E2EE
      } else {
        // 没有缓存时直接通过服务器发送
        await this.#server.sendToUser(fromUserId, fromSessionId, {
          type: "__service_response",
          id: query.id,
          services,
        });
      }
    } catch {
      // 失败静默
    }
  }

  /**
   * 将 __app 消息分发给 ServiceRegistry 中注册的 handler
   */
  async #dispatchToServiceApp(fromUserId, fromSessionId, messageData, viaServer) {
    const appId = messageData.__app;
    const data = messageData.__data;
    const handler = this.#serviceRegistry.getHandler(appId);
    if (!handler) return; // 未注册该 app，静默丢弃

    // 获取或创建 RemoteUser 供 ctx 使用
    let remoteUser;
    if (this.#remoteUserCache.has(fromUserId)) {
      remoteUser = await this.#remoteUserCache.get(fromUserId);
    } else {
      try {
        remoteUser = await this.connectUser(fromUserId);
      } catch {
        // 无法 connect 时创建一个轻量 RemoteUser（不查在线状态）
        remoteUser = new RemoteUser(fromUserId, this);
        this.#remoteUserCache.set(fromUserId, Promise.resolve(remoteUser));
        this.#watchUser(fromUserId);
      }
    }

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
    const promise = this.#doConnectUser(userId);
    this.#remoteUserCache.set(userId, promise);

    try {
      return await promise;
    } catch {
      // 失败时清理缓存，允许下次重试
      this.#remoteUserCache.delete(userId);
      throw new Error(`User ${userId} is not online on any connected server`);
    }
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
    // 自动在所有已连接服务器注册关注，以便接收对方 session 的下线通知
    this.#watchUser(userId);
    return remoteUser;
  }

  /**
   * 断开与远程用户的连接
   * 取消关注其下线通知，并清理本地缓存
   * @param {string} userId - 目标用户的 userId
   */
  async disconnectUser(userId) {
    await this.#unwatchUser(userId);
    this.#remoteUserCache.delete(userId);
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
