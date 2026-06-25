/**
 * ServiceRegistry — 应用服务注册与分发管理器
 *
 * 允许本地用户注册一个或多个应用服务（appId），
 * 每个服务可配置是否暴露给服务端（exposeToServer，默认不暴露）。
 *
 * 入站消息中若携带 __app 字段，会自动路由到对应的服务 handler，
 * 无需开发者手动管理 sessionId。
 *
 * 使用方式：
 *   const svc = localUser.registerService("chat-v1", {
 *     onMessage(data, ctx) { ... }
 *   });
 *   svc.unregister();
 */
export class ServiceRegistry {
  #localUser;
  #services; // Map<appId, { exposeToServer, onMessage }>

  /**
   * @param {import("./user.js").LocalUser} localUser - 本地用户实例
   */
  constructor(localUser) {
    this.#localUser = localUser;
    this.#services = new Map();
  }

  /**
   * 注册一个应用服务
   *
   * @param {string} appId - 应用唯一标识，如 "chat-v1"
   * @param {Object} [options]
   * @param {boolean} [options.exposeToServer=false] - 是否将 appId 暴露给服务端
   * @param {Function} [options.onMessage] - 收到对方应用消息时的回调
   *        onMessage(data, ctx) 其中 ctx = { fromUserId, fromSessionId, remoteUser }
   * @returns {{ appId: string, unregister: () => void }}
   */
  register(appId, options = {}) {
    if (this.#services.has(appId)) {
      throw new Error(`Service "${appId}" is already registered`);
    }

    const { exposeToServer = false, onMessage = null } = options;

    this.#services.set(appId, { exposeToServer, onMessage });

    // 若选择暴露给服务端，通知所有已连接服务器
    if (exposeToServer) {
      this.#syncToServer();
    }

    return {
      appId,
      unregister: () => this.unregister(appId),
    };
  }

  /**
   * 注销一个应用服务
   * @param {string} appId
   */
  unregister(appId) {
    if (!this.#services.has(appId)) return;
    const wasExposed = this.#services.get(appId).exposeToServer;
    this.#services.delete(appId);
    if (wasExposed) {
      this.#syncToServer();
    }
  }

  /**
   * 将当前所有公开服务的 appId 列表同步给所有已连接服务器
   */
  #syncToServer() {
    const services = this.getServiceList();
    for (const url of this.#localUser.server.connectedUrls) {
      this.#localUser.server.sendToServer(
        url,
        JSON.stringify({
          type: "update_services",
          services,
        }),
      ).catch(() => {});
    }
  }

  /**
   * 获取本地所有已注册的 appId 列表（含公开和私密）
   * @returns {string[]}
   */
  getServiceList() {
    return [...this.#services.keys()];
  }

  /**
   * 获取本地已注册且公开的 appId 列表
   * @returns {string[]}
   */
  getExposedServiceList() {
    return [...this.#services.values()]
      .filter((r) => r.exposeToServer)
      .map((r) => r.appId);
  }

  /**
   * 获取指定 appId 的 onMessage handler
   * @param {string} appId
   * @returns {Function|null}
   */
  getHandler(appId) {
    const entry = this.#services.get(appId);
    return entry ? entry.onMessage : null;
  }

  /**
   * 检查本地是否注册了指定 appId
   * @param {string} appId
   * @returns {boolean}
   */
  has(appId) {
    return this.#services.has(appId);
  }
}
