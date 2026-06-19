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
   * 获取已连接用户列表（支持分页）
   * @param {string} url - 服务器 WebSocket 地址
   * @param {Object} [options] - 分页选项
   * @param {number} [options.page=1] - 页码（从 1 开始）
   * @param {number} [options.pageSize=20] - 每页数量
   * @returns {Promise<Object>} 包含用户列表、总数、当前页等信息的响应
   */
  async listUsers(url, { page = 1, pageSize = 20 } = {}) {
    return this.#adminCommand(url, "list_users", { page, page_size: pageSize });
  }

  async listUserGroups(url, { page = 1, pageSize = 20 } = {}) {
    return this.#adminCommand(url, "list_user_groups", { page, page_size: pageSize });
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
   * 获取服务器流量统计数据
   * 返回全局总流量、各用户流量汇总、分钟级时间分布
   * @param {string} url - 服务器 WebSocket 地址
   * @returns {Promise<Object>} 流量统计信息
   */
  async getTrafficStats(url, { limit } = {}) {
    return this.#adminCommand(url, "get_traffic_stats", { limit });
  }

  /**
   * 查询历史流量数据
   * @param {string} url - 服务器 WebSocket 地址
   * @param {Object} [options] - 查询选项
   * @param {number} [options.fromMs] - 起始时间戳（毫秒），默认 1 小时前
   * @param {string} [options.userId] - 按用户 ID 筛选（可选）
   * @returns {Promise<Object>} 历史流量数据
   */
  async getTrafficHistory(url, { fromMs, userId } = {}) {
    return this.#adminCommand(url, "get_traffic_history", {
      page: fromMs ? Math.floor(fromMs / 1000) : 0,
      user_id: userId,
    });
  }

  /**
   * 获取系统指标历史数据（CPU + 内存使用率）
   * 数据由服务器每 30 秒自动采集
   * @param {string} url - 服务器 WebSocket 地址
   * @param {Object} [options] - 查询选项
   * @param {number} [options.limit=60] - 返回最近 N 条记录
   * @returns {Promise<Object>} 包含 systemStats 数组的响应
   */
  async getSystemStatsHistory(url, { limit = 60 } = {}) {
    return this.#adminCommand(url, "get_system_stats_history", { limit });
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
