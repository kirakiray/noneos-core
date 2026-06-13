import { BaseUser } from "../base-user.js";
import {
  getUserKeys,
  saveUserKeys,
  saveUserInfo,
  getUserInfo,
} from "../db.js";
import { generateKeyPair } from "../../crypto/crypto-ecdsa.js";
import { CertManager } from "./cert.js";

// 全局初始化 Promise 缓存，防止同一 namespace 并发初始化
const initPromises = new Map();

/**
 * 本地用户类，继承自 BaseUser
 * 根据传入的命名空间在 IndexedDB 中管理公钥和私钥
 */
export class LocalUser extends BaseUser {
  #namespace;
  #sessionId = "s-" + Math.random().toString(36).substring(2, 10);
  #wsMap = new Map();
  #cert;

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
      const defaultUsername = "user-" + Math.random().toString(36).substring(2, 10);
      await this.updateInfo({ username: defaultUsername });
    }

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
    const existingInfo = await getUserInfo(this.#namespace) || {};

    // 合并数据，移除签名相关字段后重新签名
    const { signTime, publicKey, signature, ...pureExistingInfo } = existingInfo;
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
   * 连接握手服务器
   * @param {string} url - 握手服务器的 WebSocket 地址
   * @returns {Promise<boolean>} 连接成功返回 true
   */
  async connectServer(url) {
    if (this.#wsMap.has(url)) {
      const existingWs = this.#wsMap.get(url);
      if (existingWs.readyState === WebSocket.OPEN || existingWs.readyState === WebSocket.CONNECTING) {
        return true;
      }
      this.#wsMap.delete(url);
    }

    const userInfo = await this.getInfo();
    if (!userInfo) {
      throw new Error("User info not found");
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let isHandshaked = false;

      const timeout = setTimeout(() => {
        if (!isHandshaked) {
          ws.close();
          reject(new Error("Handshake timeout"));
        }
      }, 5000);

      ws.onopen = () => {
        // 等待服务器发送握手挑战 (Challenge)
      };

      ws.onmessage = async (event) => {
        if (!isHandshaked) {
          try {
            const data = JSON.parse(event.data);

            // 1. 处理服务器发送的挑战
            if (data.type === "handshake_challenge") {
              const response = await this._sign({
                type: "handshake_response",
                challenge: data.challenge,
                userId: this.userId,
                sessionId: this.#sessionId,
                username: userInfo.username
              });
              ws.send(JSON.stringify(response));
              return;
            }

            // 2. 处理最终的握手结果
            if (data.type === "handshake" && data.status === "success") {
              clearTimeout(timeout);
              isHandshaked = true;
              this.#wsMap.set(url, ws);
              
              // 绑定后续消息处理
              ws.onmessage = (e) => {
                const messageEvent = new CustomEvent("message", {
                  detail: {
                    url: url,
                    data: e.data,
                    originalEvent: e
                  }
                });
                this.dispatchEvent(messageEvent);
              };

              // 绑定关闭处理
              ws.onclose = () => {
                this.#wsMap.delete(url);
                const closeEvent = new CustomEvent("close", {
                  detail: { url: url }
                });
                this.dispatchEvent(closeEvent);
              };

              resolve(true);
            } else {
              const error = new Error(data.message || "Handshake failed");
              error.details = data;
              reject(error);
              ws.close();
            }
          } catch (e) {
            reject(new Error("Invalid handshake response: " + event.data));
            ws.close();
          }
        }
      };

      ws.onerror = (err) => {
        if (!isHandshaked) {
          clearTimeout(timeout);
          reject(err);
        }
      };

      ws.onclose = (event) => {
        if (!isHandshaked) {
          clearTimeout(timeout);
          reject(new Error(event.reason || "Connection closed during handshake"));
        }
      };
    });
  }

  /**
   * 向指定服务器发送数据
   * @param {string} url - 服务器地址
   * @param {string|ArrayBuffer|Blob} data - 发送的数据
   */
  sendToServer(url, data) {
    const ws = this.#wsMap.get(url);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Connection to ${url} is not open`);
    }
    ws.send(data);
  }

  /**
   * 发送 JSON 命令到服务器并等待匹配的响应
   * @param {string} url - 服务器地址
   * @param {Object} request - 请求对象
   * @param {string} responseType - 期望的响应 type
   * @param {string} [responseAction] - 可选的响应 action 匹配
   * @param {number} [timeout=5000] - 超时时间（毫秒）
   * @returns {Promise<Object>} 响应对象
   */
  async #sendJsonCommand(url, request, responseType, responseAction, timeout = 5000) {
    await this.connectServer(url);

    return new Promise((resolve, reject) => {
      const handler = (e) => {
        let data;
        try {
          data = typeof e.detail.data === "string" ? JSON.parse(e.detail.data) : e.detail.data;
        } catch {
          return;
        }
        if (data?.type === responseType) {
          if (responseAction === undefined || data.action === responseAction) {
            this.removeEventListener("message", handler);
            resolve(data);
          }
        }
      };

      this.addEventListener("message", handler);
      this.sendToServer(url, JSON.stringify(request));

      setTimeout(() => {
        this.removeEventListener("message", handler);
        reject(new Error(`Command timed out (type: ${responseType})`));
      }, timeout);
    });
  }

  /**
   * 查询指定 userId 是否在线，以及其当前 sessionId 列表
   * @param {string} url - 服务器地址
   * @param {string} targetUserId - 要查询的用户 ID
   * @returns {Promise<{online: boolean, sessions: string[]}>}
   */
  async queryUserOnline(url, targetUserId) {
    const result = await this.#sendJsonCommand(
      url,
      { type: "query", action: "user_online", user_id: targetUserId },
      "query_response",
      "user_online",
    );
    if (result.status === "ok") {
      return { online: result.online, sessions: result.sessions };
    }
    throw new Error(result.message || "Query failed");
  }

  /**
   * 通过服务器转发数据到指定 userId 的指定 sessionId
   * @param {string} url - 服务器地址
   * @param {string} targetUserId - 目标用户 ID
   * @param {string} targetSessionId - 目标会话 ID
   * @param {*} data - 要发送的数据（任何 JSON 可序列化的值）
   * @returns {Promise<Object>} 发送结果
   */
  async sendToUser(url, targetUserId, targetSessionId, data) {
    return this.#sendJsonCommand(
      url,
      { type: "relay", action: "send_data", target_user_id: targetUserId, target_session_id: targetSessionId, data },
      "relay_response",
      "send_data",
    );
  }
}
