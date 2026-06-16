import { LocalUser } from "./local/user.js";

/**
 * 管理员用户类，继承自 LocalUser
 * 封装管理员相关操作：列出用户、断开用户连接、获取系统信息等
 */
export class AdminUser extends LocalUser {
  /**
   * 发送管理员命令并等待响应
   * @param {string} url - 服务器 WebSocket 地址
   * @param {string} action - 管理操作名称
   * @param {Object} extra - 额外参数
   * @returns {Promise<Object>} 管理命令响应
   */
  async #adminCommand(url, action, extra = {}) {
    await this.server.connect(url);

    return new Promise((resolve, reject) => {
      const handler = (e) => {
        let data;
        try {
          data = typeof e.detail.data === "string" ? JSON.parse(e.detail.data) : e.detail.data;
        } catch {
          return;
        }
        if (data?.type === "admin_response" && data.action === action) {
          this.removeEventListener("message", handler);
          resolve(data);
        }
      };

      const unbind = this.bind("message", handler);

      this.server.sendToServer(url, JSON.stringify({ type: "admin", action, ...extra }));

      setTimeout(() => {
        unbind();
        reject(new Error(`Admin command "${action}" timed out`));
      }, 5000);
    });
  }

  /**
   * 获取已连接用户列表
   * @param {string} url - 服务器 WebSocket 地址
   * @returns {Promise<Object>} 包含用户列表的响应
   */
  async listUsers(url) {
    return this.#adminCommand(url, "list_users");
  }

  /**
   * 断开指定用户的连接
   * @param {string} url - 服务器 WebSocket 地址
   * @param {string} userId - 目标用户 ID
   * @returns {Promise<Object>} 操作结果
   */
  async disconnectUser(url, userId) {
    return this.#adminCommand(url, "disconnect_user", { user_id: userId });
  }

  /**
   * 获取服务器系统信息
   * @param {string} url - 服务器 WebSocket 地址
   * @returns {Promise<Object>} 包含系统信息的响应
   */
  async getSystemInfo(url) {
    return this.#adminCommand(url, "get_system_info");
  }

  /**
   * 断开指定用户的指定会话
   * @param {string} url - 服务器 WebSocket 地址
   * @param {string} userId - 目标用户 ID
   * @param {string} sessionId - 目标会话 ID
   * @returns {Promise<Object>} 操作结果
   */
  async disconnectSession(url, userId, sessionId) {
    return this.#adminCommand(url, "disconnect_session", { user_id: userId, session_id: sessionId });
  }
}
