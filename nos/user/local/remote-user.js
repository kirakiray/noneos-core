import { BaseUser } from "../base-user.js";

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
   * 自动选择对方在线且延迟最低的服务器转发
   * @param {string} sessionId - 目标会话 ID
   * @param {*} data - 要发送的数据（JSON 可序列化值或二进制数据）
   * @returns {Promise<Object>} 发送结果
   */
  async send(sessionId, data) {
    return this.#localUser.server.sendToUser(this.#userId, sessionId, data);
  }

  /**
   * 绑定事件监听器
   * 支持 "message" 事件，监听来自该远程用户的消息
   * @param {string} eventName - 事件名称
   * @param {Function} callback - 回调函数
   * @returns {Function} 解绑函数
   */
  bind(eventName, callback) {
    if (eventName === "message") {
      const handler = (event) => {
        try {
          const rawData =
            typeof event.detail.data === "string"
              ? event.detail.data
              : new TextDecoder().decode(event.detail.data);
          const parsed = JSON.parse(rawData);

          if (parsed.type === "relay" && parsed.from_user_id === this.#userId) {
            const detail = {
              fromUserId: parsed.from_user_id,
              fromSessionId: parsed.from_session_id,
              data: parsed.data,
              viaServer: event.detail.url,
            };
            callback(new CustomEvent("message", { detail }));
          }
        } catch {
          // 非 JSON 消息或解析错误，忽略
        }
      };

      this.#localUser.addEventListener(eventName, handler);

      return () => {
        this.#localUser.removeEventListener(eventName, handler);
      };
    }

    return super.bind(eventName, callback);
  }
}
