import { BaseUser } from "../base-user.js";
import { tryEncryptBinary } from "../../crypto/crypto-e2ee.js";

/**
 * 远程用户类，代表通过服务器连接的另一个用户
 * 提供查询对方在线状态、发送数据、接收消息的能力
 */
export class RemoteUser extends BaseUser {
  #userId;
  #localUser;

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
   * @param {string} sessionId - 目标会话 ID
   * @param {*} data - 要发送的数据（JSON 可序列化值）
   * @param {boolean} [raw=false] - 内部使用，设为 true 跳过加密
   * @returns {Promise<Object>} 发送结果
   */
  async send(sessionId, data, raw = false) {
    // 仅对纯对象启用 E2EE 加密（跳过数组、Uint8Array 等二进制数据）
    if (!raw && data && typeof data === "object" && !Array.isArray(data) && !ArrayBuffer.isView(data) && !(data instanceof Blob)) {
      const encrypted = await tryEncryptBinary(this.#localUser, this.#userId, data);
      if (encrypted !== null) {
        // 加密成功，以二进制帧形式发送，零 base64 开销
        return this.#localUser.server.sendToUser(this.#userId, sessionId, encrypted);
      }
    }
    return this.#localUser.server.sendToUser(this.#userId, sessionId, data);
  }
}
