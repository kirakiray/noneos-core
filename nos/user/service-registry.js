/**
 * ServiceRegistry — 应用服务注册与分发管理器
 *
 * 允许本地用户注册一个或多个应用服务（appId），
 * 每个服务可配置是否暴露给服务端（exposeToServer，默认不暴露）。
 *
 * 入站消息中若携带 __app 字段，会自动路由到对应的服务 handler，
 * 无需开发者手动管理 sessionId。
 *
 * 注册/注销时会向所有已缓存的 RemoteUser 主动广播
 * `__service_available` / `__service_unavailable`，
 * 让对端实时更新服务会话缓存，实现精准投递。
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

    // 向所有已缓存的 RemoteUser 主动广播「我这个 session 上线了 appId」
    // 让对端更新其 serviceSessionCache，后续 sendToService 才能精准投递
    this.#broadcastAvailability(appId, true);

    // 本地事件：便于业务在需要时监听自身服务注册状态
    this.#localUser._trigger("service_registered", { appId });

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

    // 向已缓存的 RemoteUser 广播「appId 下线」
    this.#broadcastAvailability(appId, false);
    this.#localUser._trigger("service_unregistered", { appId });
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
   * 向所有已建立通信的 RemoteUser 广播服务上/下线通知
   * 使 sendToService 能立刻精准投递到新注册的 session
   * @param {string} appId
   * @param {boolean} available true=上线 false=下线
   */
  #broadcastAvailability(appId, available) {
    for (const remote of this.#localUser.remoteUsers) {
      // 静默失败（对端可能刚断线），不影响本地注册流程
      remote._notifyServiceChange(appId, available).catch(() => {});
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
