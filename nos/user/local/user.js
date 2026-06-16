import { BaseUser } from "../base-user.js";
import { getUserKeys, saveUserKeys, saveUserInfo, getUserInfo } from "../db.js";
import { generateKeyPair } from "../../crypto/crypto-ecdsa.js";
import { CertManager } from "./cert.js";
import { ServerManager } from "./server.js";
import { RemoteUser } from "./remote-user.js";

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
  #server;
  #sessionChannel;
  #remoteUserCache = new Map(); // userId -> Promise<RemoteUser>

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
    this.#server = new ServerManager(this);
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

    // 监听 relay 消息并分发给对应的 RemoteUser 实例
    this.#setupRelayDispatch();
  }

  /**
   * 设置 relay 消息分发：当本地用户收到 relay 消息时，
   * 解析后分发给缓存的 RemoteUser 实例
   *
   * 同时处理 WebRTC 信令消息（data.type === "__webrtc"）：
   * - 若缓存中已有对应 RemoteUser，分派信令给该实例
   * - 若没有，自动创建 RemoteUser（作为 answerer）并加入缓存
   */
  #setupRelayDispatch() {
    this.bind("message", (event) => {
      let rawData;
      try {
        rawData =
          typeof event.detail.data === "string"
            ? event.detail.data
            : new TextDecoder().decode(event.detail.data);
      } catch {
        return;
      }

      let parsed;
      try {
        parsed = JSON.parse(rawData);
      } catch {
        return;
      }

      if (parsed.type !== "relay") return;

      const fromUserId = parsed.from_user_id;
      if (!fromUserId) return;

      const innerData = parsed.data;

      // WebRTC 信令消息：分派给对应 RemoteUser 处理
      if (
        innerData &&
        typeof innerData === "object" &&
        innerData.type === "__webrtc"
      ) {
        this.#dispatchWebRTCSignal(
          fromUserId,
          parsed.from_session_id,
          innerData,
        );
        return;
      }

      // 普通 relay 消息：查找缓存的 RemoteUser 实例并触发 message 事件
      if (this.#remoteUserCache.has(fromUserId)) {
        const remoteUserPromise = this.#remoteUserCache.get(fromUserId);
        // Promise 已完成才能拿到 RemoteUser
        Promise.resolve(remoteUserPromise).then((remoteUser) => {
          remoteUser._trigger("message", {
            fromUserId,
            fromSessionId: parsed.from_session_id,
            data: parsed.data,
            viaServer: event.detail.url,
          });
        });
      }
    });
  }

  /**
   * 分派 WebRTC 信令给对应的 RemoteUser 实例
   * 若缓存中不存在则自动创建（作为 answerer，非 initiator）
   * @param {string} fromUserId - 信令发送方的 userId
   * @param {string} fromSessionId - 信令发送方的 sessionId
   * @param {Object} signal - 信令数据
   */
  async #dispatchWebRTCSignal(fromUserId, fromSessionId, signal) {
    let remoteUser;

    if (this.#remoteUserCache.has(fromUserId)) {
      const promise = this.#remoteUserCache.get(fromUserId);
      remoteUser = await promise;
    } else {
      // 自动创建 RemoteUser 作为 answerer（非 initiator）
      remoteUser = new RemoteUser(fromUserId, this, false);
      this.#remoteUserCache.set(fromUserId, Promise.resolve(remoteUser));
    }

    remoteUser._handleSignal(signal, fromSessionId);
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
   * 获取服务器管理器
   */
  get server() {
    return this.#server;
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
   * @param {Object} [options] - 连接选项
   * @param {"auto" | "relay" | "webrtc"} [options.mode="auto"] - 传输模式：
   *   - "auto"（默认）：发起 WebRTC 连接，DataChannel 可用时优先走 P2P，否则回退 relay
   *   - "relay"：不发起 WebRTC，仅使用服务端 relay 转发
   *   - "webrtc"：发起 WebRTC，仅使用 P2P，DataChannel 不可用时 send() 抛出错误
   *   实例化后仍可通过 RemoteUser.setTransportMode() 自由切换传输模式。
   * @returns {Promise<RemoteUser>}
   */
  async connectUser(userId, options = {}) {
    if (!userId) {
      throw new Error("userId is required");
    }

    const { mode = "auto" } = options;
    if (mode !== "auto" && mode !== "relay" && mode !== "webrtc") {
      throw new Error(`Invalid transport mode: ${mode}`);
    }

    // 已有缓存（进行中的 Promise 或已完成的 RemoteUser）
    if (this.#remoteUserCache.has(userId)) {
      const cached = await this.#remoteUserCache.get(userId);
      // 缓存实例已存在，按本次请求同步传输模式
      if (cached.transportMode !== mode) {
        cached.setTransportMode(mode);
      }
      return cached;
    }

    // 发起连接，Promise 存入缓存，并发调用复用同一 Promise
    const promise = this.#doConnectUser(userId, mode);
    this.#remoteUserCache.set(userId, promise);

    try {
      return await promise;
    } catch {
      // 失败时清理缓存，允许下次重试
      this.#remoteUserCache.delete(userId);
      throw new Error(`User ${userId} is not online on any connected server`);
    }
  }

  async #doConnectUser(userId, mode) {
    // 查询已连接服务器，确认目标用户至少在一台服务器上在线
    const urls = this.#server.connectedUrls;
    let found = false;
    for (const url of urls) {
      try {
        const result = await this.#server.queryUserOnline(url, userId);
        if (result.online) {
          found = true;
          break;
        }
      } catch {
        continue;
      }
    }
    if (!found) {
      throw new Error(`User ${userId} is not online on any connected server`);
    }
    // mode !== "relay" 时作为 initiator 创建 RemoteUser，构造函数中会自动发起 WebRTC 连接
    // mode === "relay" 时不发起 WebRTC，仅创建 RemoteUser 并强制使用 relay 模式
    const useWebRTC = mode !== "relay";
    const remoteUser = new RemoteUser(userId, this, useWebRTC);
    remoteUser.setTransportMode(mode);
    return remoteUser;
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
