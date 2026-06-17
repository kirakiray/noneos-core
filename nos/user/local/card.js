import {
  saveCardToDb,
  getCardFromDb,
  deleteCardFromDb,
  iterateCards,
  countCards,
} from "../db.js";
import { verifyData } from "../../crypto/crypto-verify.js";
import { getHash } from "../../util/hash/get-hash.js";

/**
 * 名片管理器
 *
 * 管理本地用户的名片收发与存储。
 * 名片即已签名的用户信息数据（getInfo() 返回值），
 * 包含 userId、publicKey、username、signTime、signature 等字段。
 *
 * 交互流程：
 * 1. 查询方本地先查 DB，看是否已有对方的名片
 * 2. 若没有（或签名时间不是最新的），向对方请求最新的名片
 * 3. 对方收到请求后，回复自己的 getInfo() 数据
 * 4. 查询方收到名片后，验证签名。通过则保存到 cards store
 * 5. 若已存在同 userId 的名片，保留 signTime 更大的那张
 */
export class CardManager {
  #user;
  #unbind;
  #requestMap = new Map(); // userId -> { resolve, reject, timer }

  /**
   * @param {import("./user.js").LocalUser} user - 本地用户实例
   */
  constructor(user) {
    this.#user = user;
  }

  /**
   * 启动名片监听
   * 自动响应 incoming 的名片请求，以及处理 incoming 的名片响应
   */
  start() {
    if (this.#unbind) return;

    this.#unbind = this.#user.bind("message", (event) => {
      this.#handleRelayMessage(event.detail);
    });
  }

  /**
   * 处理 relay 消息中的名片协议
   */
  async #handleRelayMessage(detail) {
    let rawData;
    try {
      rawData =
        typeof detail.data === "string"
          ? detail.data
          : new TextDecoder().decode(detail.data);
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
    if (!parsed.data || parsed.data.type !== "card") return;

    const cardMsg = parsed.data;
    const fromUserId = parsed.from_user_id;
    const fromSessionId = parsed.from_session_id;
    const viaServer = detail.url;

    if (cardMsg.action === "request") {
      await this.#handleCardRequest(fromUserId, fromSessionId, viaServer);
    } else if (cardMsg.action === "response") {
      await this.#handleCardResponse(cardMsg.data, fromUserId);
    }
  }

  /**
   * 处理 incoming 名片请求：回复自己的 getInfo()
   */
  async #handleCardRequest(fromUserId, fromSessionId, viaServer) {
    const myInfo = await this.#user.getInfo();
    if (!myInfo) return;

    try {
      await this.#user.server.relayToUserViaServer(viaServer, fromUserId, fromSessionId, {
        type: "card",
        action: "response",
        data: myInfo,
      });
    } catch (err) {
      console.warn("[CardManager] Failed to send card response:", err.message);
    }
  }

  /**
   * 处理 incoming 名片响应：验证签名后保存
   */
  async #handleCardResponse(cardData, fromUserId) {
    if (!cardData || cardData.userId !== fromUserId) {
      console.warn("[CardManager] Card userId mismatch");
      this.#rejectRequest(fromUserId, new Error("Card userId mismatch"));
      return;
    }

    try {
      const isValid = await this.#verifyCard(cardData);
      if (!isValid) throw new Error("Invalid card signature");
    } catch (err) {
      console.warn("[CardManager] Card verification failed:", err.message);
      this.#rejectRequest(fromUserId, err);
      return;
    }

    const saved = await saveCardToDb(this.#user.namespace, cardData);
    this.#user._trigger("card_received", { userId: fromUserId, card: cardData, saved });
    this.#resolveRequest(fromUserId, cardData);
  }

  /**
   * 验证名片签名
   */
  async #verifyCard(cardData) {
    const keyUserId = await getHash(cardData.publicKey);
    if (keyUserId !== cardData.userId) {
      console.warn("[CardManager] publicKey does not match userId");
      return false;
    }
    return verifyData(cardData);
  }

  /**
   * 自动查找远程用户的在线 sessionId
   */
  async #findSessionId(userId) {
    const server = this.#user.server;
    const urls = server.connectedUrls;

    for (const url of urls) {
      try {
        const result = await server.queryUserOnline(url, userId);
        if (result.online && result.sessions && result.sessions.length > 0) {
          return result.sessions[0];
        }
      } catch {
        continue;
      }
    }

    throw new Error(`User ${userId} is not online on any connected server`);
  }

  /**
   * 从本地数据库获取名片
   * @param {string} userId
   * @returns {Promise<Object | null>}
   */
  async getByDB(userId) {
    return getCardFromDb(this.#user.namespace, userId);
  }

  /**
   * 删除名片
   * @param {string} userId
   */
  async delete(userId) {
    return deleteCardFromDb(this.#user.namespace, userId);
  }

  /**
   * 统计名片数量
   * @returns {Promise<number>}
   */
  async count() {
    return countCards(this.#user.namespace);
  }

  /**
   * 遍历所有已保存的名片
   * @returns {AsyncIterable}
   */
  values() {
    return iterateCards(this.#user.namespace);
  }

  /**
   * 获取远程用户的名片
   *
   * 统一入口：先查本地 DB，没有再通过网路请求获取。
   *
   * @param {string} userId - 目标用户的 userId
   * @returns {Promise<Object>} 名片数据
   */
  async get(userId) {
    if (!userId) throw new Error("userId is required");

    const existing = await this.getByDB(userId);
    if (existing) return existing;

    return this.requestCard(userId);
  }

  /**
   * 向远程用户请求名片（总是发起网络请求）
   *
   * @param {string} userId - 目标用户的 userId
   * @returns {Promise<Object>} 名片数据
   */
  async requestCard(userId) {
    if (!userId) throw new Error("userId is required");

    if (this.#requestMap.has(userId)) {
      return this.#requestMap.get(userId).promise;
    }

    const remoteUser = await this.#user.connectUser(userId);
    const sessionId = await this.#findSessionId(userId);

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#requestMap.delete(userId);
        reject(new Error(`Card request timed out for user ${userId}`));
      }, 10000);

      this.#requestMap.set(userId, { resolve, reject, timer, promise: null });
    });

    const entry = this.#requestMap.get(userId);
    entry.promise = promise;

    await remoteUser.send(sessionId, { type: "card", action: "request" });
    return promise;
  }

  #resolveRequest(userId, cardData) {
    if (this.#requestMap.has(userId)) {
      const { resolve, timer } = this.#requestMap.get(userId);
      clearTimeout(timer);
      this.#requestMap.delete(userId);
      resolve(cardData);
    }
  }

  #rejectRequest(userId, error) {
    if (this.#requestMap.has(userId)) {
      const { reject, timer } = this.#requestMap.get(userId);
      clearTimeout(timer);
      this.#requestMap.delete(userId);
      reject(error);
    }
  }
}
