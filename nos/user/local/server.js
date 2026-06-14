import { getServerList, saveServerList } from "../db.js";

const DEFAULT_SERVERS = ["ws://localhost:8081", "ws://localhost:8082"];

export class ServerManager {
  #wsMap = new Map();
  #user;
  #servers = [];
  #serversLoaded = false;

  constructor(user) {
    this.#user = user;
  }

  /**
   * 获取服务器列表
   * @returns {Promise<string[]>}
   */
  async getServers() {
    if (!this.#serversLoaded) {
      await this.#loadServers();
    }
    return [...this.#servers];
  }

  /**
   * 添加服务器到列表
   * @param {string} url - 服务器 WebSocket 地址
   */
  async addServer(url) {
    if (!this.#serversLoaded) {
      await this.#loadServers();
    }
    if (!this.#servers.includes(url)) {
      this.#servers.push(url);
      await this.#saveServers();
    }
  }

  /**
   * 从列表中删除服务器
   * @param {string} url - 服务器 WebSocket 地址
   */
  async removeServer(url) {
    if (!this.#serversLoaded) {
      await this.#loadServers();
    }
    this.#servers = this.#servers.filter((s) => s !== url);
    await this.#saveServers();
  }

  /**
   * 从数据库加载服务器列表，若无则使用默认列表
   */
  async #loadServers() {
    const saved = await getServerList(this.#user.namespace);
    if (saved && saved.length > 0) {
      this.#servers = saved;
    } else {
      this.#servers = [...DEFAULT_SERVERS];
      await this.#saveServers();
    }
    this.#serversLoaded = true;
  }

  /**
   * 保存服务器列表到数据库
   */
  async #saveServers() {
    await saveServerList(this.#user.namespace, this.#servers);
  }

  /**
   * 连接列表中的所有服务器
   * 失败的连接不会抛出错误，只会在控制台输出警告
   */
  async connectAll() {
    if (!this.#serversLoaded) {
      await this.#loadServers();
    }
    const promises = this.#servers.map((url) =>
      this.connect(url).catch((err) => {
        console.warn(
          `[ServerManager] Auto-connect to ${url} failed:`,
          err.message,
        );
      }),
    );
    await Promise.allSettled(promises);
  }

  /**
   * 连接握手服务器
   * @param {string} url - 握手服务器的 WebSocket 地址
   * @returns {Promise<boolean>} 连接成功返回 true
   */
  async connect(url) {
    debugger;
    if (this.#wsMap.has(url)) {
      const existingWs = this.#wsMap.get(url);
      if (
        existingWs.readyState === WebSocket.OPEN ||
        existingWs.readyState === WebSocket.CONNECTING
      ) {
        return true;
      }
      this.#wsMap.delete(url);
    }

    const userInfo = await this.#user.getInfo();
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
              const response = await this.#user._sign({
                type: "handshake_response",
                challenge: data.challenge,
                userId: this.#user.userId,
                sessionId: this.#user.sessionId,
                username: userInfo.username,
                host: window.location.origin,
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
                    originalEvent: e,
                  },
                });
                this.#user.dispatchEvent(messageEvent);
              };

              // 绑定关闭处理
              ws.onclose = () => {
                this.#wsMap.delete(url);
                const closeEvent = new CustomEvent("close", {
                  detail: { url: url },
                });
                this.#user.dispatchEvent(closeEvent);
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
          reject(
            new Error(event.reason || "Connection closed during handshake"),
          );
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
  async #sendJsonCommand(
    url,
    request,
    responseType,
    responseAction,
    timeout = 5000,
  ) {
    await this.connect(url);

    return new Promise((resolve, reject) => {
      const handler = (e) => {
        let data;
        try {
          data =
            typeof e.detail.data === "string"
              ? JSON.parse(e.detail.data)
              : e.detail.data;
        } catch {
          return;
        }
        if (data?.type === responseType) {
          if (responseAction === undefined || data.action === responseAction) {
            this.#user.removeEventListener("message", handler);
            resolve(data);
          }
        }
      };

      this.#user.addEventListener("message", handler);
      this.sendToServer(url, JSON.stringify(request));

      setTimeout(() => {
        this.#user.removeEventListener("message", handler);
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
      {
        type: "relay",
        action: "send_data",
        target_user_id: targetUserId,
        target_session_id: targetSessionId,
        data,
      },
      "relay_response",
      "send_data",
    );
  }
}
