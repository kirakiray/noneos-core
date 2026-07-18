import { LocalUser } from "./user.js";

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
    // 单次发送 + 等待响应；失败时由外层重试一次
    const attempt = async () => {
      await this.server.connect(url);

      return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          settled = true;
          unbindMessage();
          unbindClose();
          unbindDisconnected();
          clearTimeout(timer);
        };

        const messageHandler = (e) => {
          if (settled) return;
          // 严格按 URL 过滤，避免其它服务器的消息干扰
          if (e.detail?.url && e.detail.url !== url) return;
          let data;
          try {
            data =
              typeof e.detail.data === "string"
                ? JSON.parse(e.detail.data)
                : e.detail.data;
          } catch {
            return;
          }
          if (data?.type === "admin_response" && data.action === action) {
            cleanup();
            resolve(data);
          }
        };

        const disconnectHandler = (e) => {
          if (settled) return;
          if (e.detail?.url && e.detail.url !== url) return;
          cleanup();
          reject(
            new Error(
              `Admin command "${action}" connection closed before response`,
            ),
          );
        };

        const unbindMessage = this.bind("message", messageHandler);
        const unbindClose = this.bind("close", disconnectHandler);
        const unbindDisconnected = this.bind(
          "server_disconnected",
          disconnectHandler,
        );

        const timer = setTimeout(() => {
          if (settled) return;
          cleanup();
          reject(new Error(`Admin command "${action}" timed out`));
        }, 15000);

        try {
          this.server.sendToServer(
            url,
            JSON.stringify({ type: "admin", action, ...extra }),
          );
        } catch (err) {
          if (settled) return;
          cleanup();
          reject(err);
        }
      });
    };

    try {
      return await attempt();
    } catch (err) {
      // 偶发的 WebSocket 中途断开导致命令未收到响应时，重连后再重试一次
      const message = err?.message || "";
      const retriable =
        message.includes("closed before response") ||
        message.includes("is not open") ||
        message.includes("timed out");
      if (!retriable) throw err;
      return attempt();
    }
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
   * 获取所有历史用户列表（包括离线用户，支持分页）
   * @param {string} url - 服务器 WebSocket 地址
   * @param {Object} [options] - 分页选项
   * @param {number} [options.page=1] - 页码
   * @param {number} [options.pageSize=20] - 每页数量
   * @returns {Promise<Object>} 包含用户列表及在线状态的响应
   */
  async listAllUsers(url, { page = 1, pageSize = 20 } = {}) {
    return this.#adminCommand(url, "list_all_users", { page, page_size: pageSize });
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
   * 查询历史流量数据（支持分页）
   * @param {string} url - 服务器 WebSocket 地址
   * @param {Object} [options] - 查询选项
   * @param {number} [options.fromMs] - 起始时间戳（毫秒），不传则服务器默认查最近 1 小时
   * @param {string} [options.userId] - 按用户 ID 筛选（可选）
   * @param {number} [options.page=1] - 页码（从 1 开始）
   * @param {number} [options.pageSize=20] - 每页数量
   * @returns {Promise<Object>} 历史流量数据（含 total/page/pageSize 字段）
   */
  async getTrafficHistory(url, { fromMs, userId, page = 1, pageSize = 20 } = {}) {
    return this.#adminCommand(url, "get_traffic_history", {
      from_ms: fromMs,
      page,
      page_size: pageSize,
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

  /**
   * 设置用户的转发流量额度（字节）
   * @param {string} url - 服务器 WebSocket 地址
   * @param {string} userId - 目标用户 ID
   * @param {number} quotaBytes - 额度字节数
   * @returns {Promise<Object>} 包含更新后额度信息的响应
   */
  async setUserRelayQuota(url, userId, quotaBytes) {
    return this.#adminCommand(url, "set_user_relay_quota", {
      user_id: userId,
      quota_bytes: quotaBytes,
    });
  }

  /**
   * 获取用户的转发流量额度（支持单个或批量获取）
   * @param {string} url - 服务器 WebSocket 地址
   * @param {string|string[]} userId - 目标用户 ID 或 ID 数组
   * @returns {Promise<Object>} 包含额度信息的响应。如果是批量查询，结果在 quotas 字段中；单个查询在 quota 字段中。
   */
  async getUserRelayQuota(url, userId) {
    if (Array.isArray(userId)) {
      return this.#adminCommand(url, "get_user_relay_quota", { user_ids: userId });
    }
    return this.#adminCommand(url, "get_user_relay_quota", { user_id: userId });
  }
}
