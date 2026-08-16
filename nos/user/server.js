import { getServerList, saveServerList } from "./db.js";
import { inferCategory, measureSize } from "./traffic.js";

const ONLINE_SERVERS = [
  "wss://hand3-jp1.noneos.com:4331",
  "wss://hand3-us1.noneos.com:4331",
  "wss://hand3-hk1.noneos.com:4331",
];

const DEFAULT_SERVERS = (() => {
  const hostname =
    typeof window !== "undefined" ? window.location.hostname : "";
  const port = typeof window !== "undefined" ? window.location.port : "";
  if (hostname === "localhost" || hostname === "127.0.0.1") {
    // 3002 为本地开发主端口，只用本地握手服务器
    if (port === "3002") {
      return ["ws://localhost:8081", "ws://localhost:8082"];
    }
    // 其他本地端口：本地服务器优先，同时保留线上服务器作为备选
    return ["ws://localhost:8081", "ws://localhost:8082", ...ONLINE_SERVERS];
  }
  return [...ONLINE_SERVERS];
})();

const CANDIDATE_CACHE_TTL = 15000; // 服务器候选排序缓存 15 秒过期

export class ServerManager {
  #wsMap = new Map();
  #serverVersions = new Map(); // url -> version
  #connectPromises = new Map();
  #user;
  #servers = [];
  #serversLoaded = false;
  #latencyTimer = null;
  #latencyIntervalMs = 30000;
  #latencyCache = new Map();
  #serverCandidateCache = new Map(); // userId -> { candidates, timestamp }
  #autoReconnectConfig = {
    enabled: false,
    baseDelay: 2000,
    maxDelay: 30000,
    multiplier: 2,
    maxRetries: Infinity,
  };
  #reconnectTasks = new Map(); // url -> { timer, attempt, nextRetryAt }
  #intentionalDisconnects = new Set(); // 用户主动断开的 url

  constructor(user) {
    this.#user = user;
  }

  /**
   * 获取当前已连接的服务器 URL 列表
   * @returns {string[]}
   */
  get connectedUrls() {
    return [...this.#wsMap.keys()];
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
   * @param {Object|number} [optionsOrRetries={ retries: 3 }] - 连接选项，或仅指定重试次数（向后兼容）
   * @param {number} [optionsOrRetries.retries=3] - 握手阶段的重试次数
   * @returns {Promise<{success: boolean, version: string|null}>} 连接成功返回 { success: true, version }
   */
  async connect(url, optionsOrRetries = { retries: 3 }) {
    let options;
    if (typeof optionsOrRetries === "number") {
      options = { retries: optionsOrRetries };
    } else {
      options = { retries: 3, ...optionsOrRetries };
    }

    // 用户主动连接某 URL 时，视为恢复自动重连的意图
    this.#intentionalDisconnects.delete(url);
    this.#clearReconnectTask(url);

    // 检查是否已有可用连接
    if (this.#wsMap.has(url)) {
      const existingWs = this.#wsMap.get(url);
      if (
        existingWs.readyState === WebSocket.OPEN ||
        existingWs.readyState === WebSocket.CONNECTING
      ) {
        return {
          success: true,
          version: this.#serverVersions.get(url) || null,
        };
      }
      this.#wsMap.delete(url);
      this.#serverVersions.delete(url);
    }

    const userInfo = await this.#user.getInfo();
    if (!userInfo) {
      throw new Error("User info not found");
    }

    // 检查是否已有同一 URL 的连接正在进行中，防止并行重复连接
    if (this.#connectPromises.has(url)) {
      return this.#connectPromises.get(url);
    }

    // 带重试的连接逻辑
    const connectWithRetry = async () => {
      let lastError;
      for (let i = 0; i <= options.retries; i++) {
        if (i > 0) {
          await new Promise((r) => setTimeout(r, 200));
          console.warn(
            `[ServerManager] Retrying connection to ${url} (attempt ${i + 1}/${options.retries})`,
          );
        }
        try {
          console.log(`[nos-debug] connectOnce start: ${url} (attempt ${i + 1})`);
          const result = await this.#connectOnce(url);
          console.log(`[nos-debug] connectOnce success: ${url}`);
          return result;
        } catch (err) {
          console.log(`[nos-debug] connectOnce failed: ${url} (${err.message})`);
          lastError = err;
        }
      }
      throw lastError;
    };

    const promise = connectWithRetry();
    this.#connectPromises.set(url, promise);
    promise.finally(() => {
      this.#connectPromises.delete(url);
    });
    return promise;
  }

  /**
   * 执行单次 WebSocket 连接与握手
   * @param {string} url
   * @returns {Promise<{success: boolean, version: string|null}>}
   */
  async #connectOnce(url) {
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
          const err = new Error("Handshake timeout");
          reject(err);
        }
      }, 30000);

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
              const responseText = JSON.stringify(response);
              ws.send(responseText);
              // 出站流量埋点：握手响应
              try {
                this.#user.traffic?.record({
                  direction: "out",
                  via: "server",
                  serverUrl: url,
                  size: measureSize(responseText),
                  category: "handshake",
                  messageType: "handshake_response",
                  success: true,
                });
              } catch {}
              return;
            }

            // 2. 处理最终的握手结果
            if (data.type === "handshake" && data.status === "success") {
              clearTimeout(timeout);
              isHandshaked = true;
              const version = data.version || null;
              this.#wsMap.set(url, ws);
              this.#serverVersions.set(url, version);

              // 清除该 URL 的重连任务，避免重连成功后旧定时器仍触发
              this.#clearReconnectTask(url);
              this.#intentionalDisconnects.delete(url);

              // 触发握手成功事件
              this.#user._trigger("handshake", {
                url,
                status: "success",
                isAdmin: data.is_admin,
                version,
              });
              this.#user._trigger("server_connected", { url, version });

              // 绑定后续消息处理
              ws.onmessage = (e) => {
                this.#user._trigger("message", {
                  url: url,
                  data: e.data,
                  originalEvent: e,
                });
              };

              // 绑定关闭处理
              ws.onclose = (event) => {
                // 如果该 URL 已经被新的连接接管，跳过旧 ws 的关闭处理
                if (this.#wsMap.get(url) !== ws) return;

                this.#wsMap.delete(url);
                this.#serverVersions.delete(url);
                this.#serverCandidateCache.clear(); // 拓扑变化，清空路由缓存
                this.#user._trigger("close", { url, reason: event.reason });
                this.#user._trigger("server_disconnected", {
                  url,
                  reason: event.reason,
                });
                // 没有活跃连接时自动停止延迟监测
                if (this.#wsMap.size === 0) {
                  this.stopLatencyMonitor();
                }

                this.#scheduleReconnect(url);
              };

              resolve({ success: true, version });

              // 连接成功后自动启动静默延迟监测
              this.#ensureLatencyMonitor();
            } else {
              // 触发握手失败事件
              this.#user._trigger("handshake", {
                url,
                status: "error",
                message: data.message || "Handshake failed",
              });

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

      ws.onerror = () => {
        if (!isHandshaked) {
          clearTimeout(timeout);
          this.#user._trigger("ws_error", {
            url,
            error: "WebSocket connection failed",
          });
          reject(new Error("WebSocket connection failed"));
        }
      };

      ws.onclose = (event) => {
        if (!isHandshaked) {
          clearTimeout(timeout);
          this.#user._trigger("ws_error", {
            url,
            error: event.reason || "Connection closed during handshake",
          });
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
      // 失败也记录一次尝试字节数
      this.#recordOutbound(url, data, false, "not_open");
      throw new Error(`Connection to ${url} is not open`);
    }
    ws.send(data);
    this.#recordOutbound(url, data, true, "");
  }

  /**
   * 记录出站流量元数据到 TrafficLogger
   */
  #recordOutbound(url, data, success, errorCode) {
    const traffic = this.#user.traffic;
    if (!traffic) return;
    try {
      const size = measureSize(data);
      let peerUserId = "";
      let sessionId = "";
      let category = "relay";
      let messageType = "";
      let appId = "";
      if (typeof data === "string") {
        try {
          const parsed = JSON.parse(data);
          if (parsed && typeof parsed === "object") {
            if (parsed.type === "relay" && parsed.action === "send_data") {
              peerUserId = parsed.target_user_id || "";
              sessionId = parsed.target_session_id || "";
              const inner = parsed.data;
              const info = inferCategory(inner);
              category = info.category;
              messageType = info.messageType;
              appId = info.appId;
            } else {
              const info = inferCategory(parsed);
              category = info.category;
              messageType = info.messageType;
              appId = info.appId;
            }
          }
        } catch {
          // 非 JSON 文本，保留默认
        }
      } else if (
        data instanceof ArrayBuffer ||
        ArrayBuffer.isView(data)
      ) {
        // 二进制帧：解析 header 获取 target_user_id / __app
        try {
          const buf =
            data instanceof ArrayBuffer
              ? data
              : data.buffer.slice(
                  data.byteOffset,
                  data.byteOffset + data.byteLength,
                );
          if (buf.byteLength >= 4) {
            const view = new DataView(buf);
            const headerLen = view.getUint32(0, false);
            if (4 + headerLen <= buf.byteLength) {
              const headerBytes = new Uint8Array(buf, 4, headerLen);
              const header = JSON.parse(new TextDecoder().decode(headerBytes));
              if (header && typeof header === "object") {
                peerUserId = header.target_user_id || "";
                sessionId = header.target_session_id || "";
                if (header.__app) {
                  category = "app";
                  messageType = "__app";
                  appId = header.__app;
                } else {
                  category = "relay";
                  messageType = "relay";
                }
              }
            }
          }
        } catch {
          category = "relay";
        }
      }
      traffic.record({
        direction: "out",
        via: "server",
        serverUrl: url,
        peerUserId,
        sessionId,
        size,
        category,
        messageType,
        appId,
        success,
        errorCode,
      });
    } catch (err) {
      console.warn("[TrafficLogger] record outbound server failed:", err);
    }
  }

  /**
   * 发送 JSON 命令到服务器并等待匹配的响应
   * @param {string} url - 服务器地址
   * @param {Object} request - 请求对象
   * @param {string} responseType - 期望的响应 type
   * @param {string} [responseAction] - 可选的响应 action 匹配
   * @param {number} [timeout=15000] - 超时时间（毫秒）
   * @returns {Promise<Object>} 响应对象
   */
  async #sendJsonCommand(
    url,
    request,
    responseType,
    responseAction,
    timeout = 15000,
  ) {
    await this.connect(url);

    return new Promise((resolve, reject) => {
      let resolved = false;
      const handler = (e) => {
        if (e.detail.url !== url) return;
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
            resolved = true;
            unbind();
            resolve(data);
          }
        }
      };

      const unbind = this.#user.bind("message", handler);
      this.sendToServer(url, JSON.stringify(request));

      setTimeout(() => {
        if (!resolved) {
          unbind();
          reject(new Error(`Command timed out (type: ${responseType})`));
        }
      }, timeout);
    });
  }

  /**
   * 查询指定 userId 是否在线，以及其当前 sessionId 列表和各 session 延迟
   * @param {string} url - 服务器地址
   * @param {string} targetUserId - 要查询的用户 ID
   * @returns {Promise<{online: boolean, sessions: string[], sessionInfo: Array<{sessionId: string, latencyMs: number|null}>}>}
   */
  async queryUserOnline(url, targetUserId) {
    const result = await this.#sendJsonCommand(
      url,
      { type: "query", action: "user_online", user_id: targetUserId },
      "query_response",
      "user_online",
    );
    if (result.status === "ok") {
      return {
        online: result.online,
        sessions: result.sessions || [],
        sessionInfo: result.sessionInfo || [],
      };
    }
    throw new Error(result.message || "Query failed");
  }

  /**
   * 查询目标用户在线的所有服务器候选，按综合延迟升序排列
   *
   * 综合延迟 = 本端到服务器单向延迟 + 目标端到服务器单向延迟
   * 本端延迟优先使用缓存（#latencyCache，每 30s 更新），无缓存则实时测量。
   *
   * @param {string} targetUserId - 目标用户 ID
   * @returns {Promise<Array<{url: string, sessions: string[], sessionInfo: Array<{sessionId: string, latencyMs: number|null}>, localLatency: number}>>}
   */
  async #getSortedServerCandidates(targetUserId) {
    // 命中缓存且在 TTL 内，直接返回
    const cached = this.#serverCandidateCache.get(targetUserId);
    if (cached && Date.now() - cached.timestamp < CANDIDATE_CACHE_TTL) {
      return cached.candidates;
    }

    const urls = [...this.#wsMap.keys()];
    if (urls.length === 0) return [];

    const results = await Promise.allSettled(
      urls.map(async (url) => {
        const { online, sessions, sessionInfo } = await this.queryUserOnline(
          url,
          targetUserId,
        );
        if (!online) return null;

        // 获取本端延迟，优先缓存，无缓存则实时测量
        let localLatency = this.#latencyCache.get(url)?.oneWayLatency ?? null;
        if (localLatency === null) {
          try {
            const result = await this.testLatency(url);
            localLatency = result.oneWayLatency;
          } catch {
            localLatency = 0;
          }
        }

        return { url, sessions, sessionInfo, localLatency };
      }),
    );

    const candidates = [];
    for (const result of results) {
      if (result.status === "fulfilled" && result.value !== null) {
        candidates.push(result.value);
      }
    }

    // 按综合延迟升序排序：本端单向 + 目标端最低单向延迟
    candidates.sort((a, b) => {
      const aRemoteMin = a.sessionInfo.reduce(
        (min, s) => Math.min(min, (s.latencyMs ?? 0) / 2),
        Infinity,
      );
      const bRemoteMin = b.sessionInfo.reduce(
        (min, s) => Math.min(min, (s.latencyMs ?? 0) / 2),
        Infinity,
      );
      return a.localLatency + aRemoteMin - (b.localLatency + bRemoteMin);
    });

    // 只缓存非空结果，避免空缓存导致重试机制失效
    if (candidates.length > 0) {
      this.#serverCandidateCache.set(targetUserId, {
        candidates,
        timestamp: Date.now(),
      });
    }

    return candidates;
  }

  /**
   * 找到目标用户在线且综合延迟最低的服务器
   *
   * 综合延迟 = 本端单向 + 目标端单向，反映 A→Server→B 的完整链路延迟。
   * 供外部（如 user.js）在 connectUser 时确认用户在线并优先选择低延迟服务器。
   *
   * @param {string} targetUserId - 目标用户 ID
   * @returns {Promise<{url: string, localLatency: number, remoteLatency: number, combinedLatency: number} | null>}
   */
  async findBestServer(targetUserId) {
    const candidates = await this.#getSortedServerCandidates(targetUserId);
    if (candidates.length === 0) return null;

    // 取综合延迟最低的服务器
    const best = candidates[0];
    const remoteMin = best.sessionInfo.reduce(
      (min, s) => Math.min(min, (s.latencyMs ?? 0) / 2),
      Infinity,
    );

    return {
      url: best.url,
      localLatency: best.localLatency,
      remoteLatency: remoteMin,
      combinedLatency: best.localLatency + remoteMin,
    };
  }

  /**
   * 检测数据是否为二进制类型
   * @param {*} data
   * @returns {boolean}
   */
  #isBinaryData(data) {
    return (
      data instanceof ArrayBuffer ||
      ArrayBuffer.isView(data) ||
      data instanceof Blob ||
      data instanceof File
    );
  }

  /**
   * 将二进制数据转换为 Uint8Array
   * @param {ArrayBuffer|ArrayBufferView|Blob|File} data
   * @returns {Promise<Uint8Array>}
   */
  async #binaryToUint8Array(data) {
    if (data instanceof ArrayBuffer) {
      return new Uint8Array(data);
    }
    if (ArrayBuffer.isView(data)) {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    }
    if (data instanceof Blob || data instanceof File) {
      const buffer = await data.arrayBuffer();
      return new Uint8Array(buffer);
    }
    throw new Error("Unsupported binary data type");
  }

  /**
   * 通过二进制帧发送 relay 命令并等待响应
   * 帧格式：[4 字节 header JSON 长度 u32 BE] + [header JSON bytes] + [原始二进制 payload]
   * @param {string} url - 服务器地址
   * @param {string} targetUserId - 目标用户 ID
   * @param {string} targetSessionId - 目标会话 ID
   * @param {ArrayBuffer|ArrayBufferView|Blob|File} data - 要发送的二进制数据
   * @returns {Promise<Object>} 发送结果
   */
  async #sendBinaryRelayCommand(url, targetUserId, targetSessionId, data) {
    await this.connect(url);

    const payloadBytes = await this.#binaryToUint8Array(data);

    const header = JSON.stringify({
      type: "relay",
      action: "send_data",
      target_user_id: targetUserId,
      target_session_id: targetSessionId,
    });
    const headerBytes = new TextEncoder().encode(header);
    const headerLen = headerBytes.length;

    if (headerLen > 0xffffffff) {
      throw new Error("Binary relay header too large");
    }

    const frame = new Uint8Array(4 + headerLen + payloadBytes.length);
    const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    view.setUint32(0, headerLen, false);
    frame.set(headerBytes, 4);
    frame.set(payloadBytes, 4 + headerLen);

    return new Promise((resolve, reject) => {
      let resolved = false;
      const handler = (e) => {
        if (e.detail.url !== url) return;
        if (typeof e.detail.data !== "string") {
          return;
        }
        let resp;
        try {
          resp = JSON.parse(e.detail.data);
        } catch {
          return;
        }
        if (resp?.type === "relay_response" && resp?.action === "send_data") {
          resolved = true;
          unbind();
          resolve(resp);
        }
      };

      const unbind = this.#user.bind("message", handler);
      this.sendToServer(url, frame);

      setTimeout(() => {
        if (!resolved) {
          unbind();
          reject(new Error("Command timed out (type: relay_response)"));
        }
      }, 5000);
    });
  }

  /**
   * 通过指定服务器转发数据到指定 userId 的指定 sessionId
   * @param {string} url - 服务器地址
   * @param {string} targetUserId - 目标用户 ID
   * @param {string} targetSessionId - 目标会话 ID
   * @param {*} data - 要发送的数据（JSON 可序列化值或二进制数据）
   * @returns {Promise<Object>} 发送结果
   */
  async relayToUserViaServer(url, targetUserId, targetSessionId, data) {
    if (this.#isBinaryData(data)) {
      return this.#sendBinaryRelayCommand(
        url,
        targetUserId,
        targetSessionId,
        data,
      );
    }

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

  /**
   * 自动查找目标用户在线且延迟最低的服务器，通过该服务器转发数据
   * @param {string} targetUserId - 目标用户 ID
   * @param {string} targetSessionId - 目标会话 ID
   * @param {*} data - 要发送的数据（JSON 可序列化值或二进制数据）
   * @returns {Promise<Object>} 发送结果
   */
  async sendToUser(targetUserId, targetSessionId, data) {
    // 使用共享算法获取按综合延迟排序的服务器候选
    const candidates = await this.#getSortedServerCandidates(targetUserId);
    if (candidates.length === 0) {
      throw new Error(
        `Target user ${targetUserId} is not online on any connected server`,
      );
    }

    // 找第一个包含目标 session 的服务器（按综合延迟从低到高）
    let lastError;
    for (const candidate of candidates) {
      if (candidate.sessions.includes(targetSessionId)) {
        try {
          const result = await this.relayToUserViaServer(
            candidate.url,
            targetUserId,
            targetSessionId,
            data,
          );
          if (result.status === "ok") {
            return { result, url: candidate.url };
          }
          lastError = new Error(result.message || "Relay failed");
        } catch (err) {
          lastError = err;
        }
      }
    }

    // 候选缓存可能已过期，清除以便下次重试
    this.#serverCandidateCache.delete(targetUserId);
    throw (
      lastError ||
      new Error(
        `Session ${targetSessionId} of user ${targetUserId} is not online`,
      )
    );
  }

  /**
   * 测试客户端到指定服务器的网络延迟
   *
   * 工作机制：
   * 1. 客户端发送 latency_test 消息（含 client_time）
   * 2. 服务器记录 server_recv_time，回复 latency_test_response（含 client_time, server_recv_time, server_send_time）
   * 3. 客户端收到响应后计算 RTT = now - client_time，单向延迟 ≈ RTT / 2
   * 4. 客户端将完整时序报告发给服务器，让服务器也知道延迟
   *
   * 两端都知道延迟，不存在伪造。
   *
   * @param {string} url - 服务器 WebSocket 地址
   * @param {number} [timeout=15000] - 超时时间（毫秒）
   * @returns {Promise<{rtt: number, oneWayLatency: number, clientTime: number, serverRecvTime: number, serverSendTime: number, clientRecvTime: number}>}
   */
  async testLatency(url, timeout = 15000) {
    // 确保已连接
    await this.connect(url);

    // 步骤 1：发送延迟测试请求，精确记录发送时间
    const clientTime = Date.now();
    const response = await this.#sendJsonCommand(
      url,
      {
        type: "latency_test",
        client_time: clientTime,
      },
      "latency_test_response",
      undefined,
      timeout,
    );

    // 步骤 2：收到响应，计算延迟
    const clientRecvTime = Date.now();
    const rtt = clientRecvTime - clientTime;
    const oneWayLatency = Math.round(rtt / 2);

    // 步骤 3：将完整时序报告发给服务器，让服务器也知晓延迟
    await this.#sendJsonCommand(
      url,
      {
        type: "latency_report",
        client_time: clientTime,
        server_recv_time: response.server_recv_time,
        server_send_time: response.server_send_time,
        client_recv_time: clientRecvTime,
      },
      "latency_report_ack",
      undefined,
      timeout,
    );

    const result = {
      rtt,
      oneWayLatency,
      clientTime,
      serverRecvTime: response.server_recv_time,
      serverSendTime: response.server_send_time,
      clientRecvTime,
    };

    // console.log(
    //   `[ServerManager] Latency to ${url}: RTT=${rtt}ms, one-way ~${oneWayLatency}ms`,
    // );

    // 触发延迟测试完成事件
    this.#user._trigger("latency_test", { url, ...result });

    // 缓存延迟结果
    this.#latencyCache.set(url, result);

    return result;
  }

  /**
   * 确保延迟监测正在运行（静默方式，无日志无事件）
   * 连接成功后自动调用
   */
  #ensureLatencyMonitor() {
    if (this.#latencyTimer) return;

    this.#latencyIntervalMs = 30000;

    const run = () => {
      const urls = [...this.#wsMap.keys()];
      for (const url of urls) {
        this.testLatency(url).catch(() => {});
      }
    };

    run();
    this.#latencyTimer = setInterval(run, this.#latencyIntervalMs);
    document.addEventListener("visibilitychange", this.#handleVisibilityChange);
  }

  /**
   * 启动周期性延迟监测（显式启动，带日志和事件通知）
   *
   * 通常不需要手动调用，连接成功后会自动静默启动。
   * 仅在需要自定义间隔或显式控制时使用。
   *
   * @param {number} [intervalMs=30000] - 测量间隔（毫秒），默认 30 秒
   */
  startLatencyMonitor(intervalMs = 30000) {
    if (this.#latencyTimer) {
      this.stopLatencyMonitor();
    }

    this.#latencyIntervalMs = intervalMs;

    const run = () => {
      const urls = [...this.#wsMap.keys()];
      for (const url of urls) {
        this.testLatency(url).catch((err) => {
          console.warn(
            `[ServerManager] Periodic latency test to ${url} failed:`,
            err.message,
          );
        });
      }
    };

    // 立即执行一次
    run();

    // 启动定时器
    this.#latencyTimer = setInterval(run, this.#latencyIntervalMs);

    // Tab 切到后台时降低频率，切回恢复
    document.addEventListener("visibilitychange", this.#handleVisibilityChange);

    console.log(
      `[ServerManager] Latency monitor started, interval=${intervalMs}ms`,
    );

    // 触发启动事件
    this.#user._trigger("latency_monitor", {
      status: "started",
      intervalMs,
    });
  }

  /**
   * 停止周期性延迟监测
   */
  stopLatencyMonitor() {
    if (this.#latencyTimer) {
      clearInterval(this.#latencyTimer);
      this.#latencyTimer = null;
    }

    document.removeEventListener(
      "visibilitychange",
      this.#handleVisibilityChange,
    );

    console.log("[ServerManager] Latency monitor stopped");
  }

  /**
   * 断开指定服务器的连接，并停止该 URL 的自动重连
   * @param {string} url - 服务器 WebSocket 地址
   */
  disconnect(url) {
    // 标记为用户主动断开，防止关闭后触发自动重连
    this.#intentionalDisconnects.add(url);
    this.#clearReconnectTask(url);

    const ws = this.#wsMap.get(url);
    if (ws) {
      // 先从 map 中移除，避免 onclose 中重复清理并触发重连
      this.#wsMap.delete(url);
      ws.close();
      this.#serverVersions.delete(url);
      this.#serverCandidateCache.clear();
      if (this.#wsMap.size === 0) {
        this.stopLatencyMonitor();
      }
    }
  }

  /**
   * 断开所有已连接服务器
   */
  disconnectAll() {
    const urls = [...this.#wsMap.keys()];
    for (const url of urls) {
      this.disconnect(url);
    }
  }

  /**
   * 获取延迟监测当前是否活跃
   * @returns {boolean}
   */
  get isLatencyMonitorActive() {
    return this.#latencyTimer !== null;
  }

  /**
   * 配置自动重连行为
   * @param {Object} options
   * @param {boolean} [options.enabled=false] - 是否启用自动重连
   * @param {number} [options.baseDelay=2000] - 首次重连间隔（毫秒）
   * @param {number} [options.maxDelay=30000] - 最大重连间隔（毫秒）
   * @param {number} [options.multiplier=2] - 指数退避乘数
   * @param {number} [options.maxRetries=Infinity] - 最大重试次数
   * @returns {ServerManager}
   */
  setAutoReconnect(options) {
    this.#autoReconnectConfig = { ...this.#autoReconnectConfig, ...options };

    // 关闭自动重连时，取消所有已排队的重连定时器
    if (!this.#autoReconnectConfig.enabled) {
      for (const [url, task] of this.#reconnectTasks) {
        clearTimeout(task.timer);
        this.#reconnectTasks.delete(url);
      }
    }

    return this;
  }

  /**
   * 清除指定 URL 的重连任务
   * @param {string} url
   */
  #clearReconnectTask(url) {
    const task = this.#reconnectTasks.get(url);
    if (task) {
      clearTimeout(task.timer);
      this.#reconnectTasks.delete(url);
    }
  }

  /**
   * 调度指定 URL 的自动重连
   * @param {string} url
   */
  #scheduleReconnect(url) {
    if (!this.#autoReconnectConfig.enabled) return;
    if (this.#intentionalDisconnects.has(url)) return;
    if (this.#reconnectTasks.has(url)) return;

    const { baseDelay } = this.#autoReconnectConfig;
    const nextRetryAt = Date.now() + baseDelay;
    const task = {
      attempt: 1,
      nextRetryAt,
      timer: setTimeout(() => this.#runReconnect(url, task), baseDelay),
    };
    this.#reconnectTasks.set(url, task);

    this.#user._trigger("server_reconnecting", {
      url,
      attempt: 1,
      nextRetryAt,
    });
  }

  /**
   * 执行一次自动重连，失败则继续调度下一次
   * @param {string} url
   * @param {Object} task
   */
  #runReconnect(url, task) {
    this.#reconnectTasks.delete(url);

    if (this.#intentionalDisconnects.has(url)) return;
    if (!this.#autoReconnectConfig.enabled) return;

    this.connect(url).catch(() => {
      if (this.#intentionalDisconnects.has(url)) return;
      if (!this.#autoReconnectConfig.enabled) return;

      const nextAttempt = task.attempt + 1;
      if (nextAttempt > this.#autoReconnectConfig.maxRetries) {
        this.#user._trigger("server_reconnect_exhausted", {
          url,
          attempt: task.attempt,
        });
        return;
      }

      const { baseDelay, maxDelay, multiplier } = this.#autoReconnectConfig;
      const delay = Math.min(
        baseDelay * Math.pow(multiplier, nextAttempt - 1),
        maxDelay,
      );
      const nextRetryAt = Date.now() + delay;

      const nextTask = {
        attempt: nextAttempt,
        nextRetryAt,
        timer: setTimeout(() => this.#runReconnect(url, nextTask), delay),
      };
      this.#reconnectTasks.set(url, nextTask);

      this.#user._trigger("server_reconnecting", {
        url,
        attempt: nextAttempt,
        nextRetryAt,
      });
    });
  }

  /**
   * 处理页面可见性变化：隐藏时降低频率，可见时恢复
   */
  #handleVisibilityChange = () => {
    if (this.#latencyTimer) {
      clearInterval(this.#latencyTimer);
      this.#latencyTimer = null;
    }

    if (document.hidden) {
      // 后台时用 5 倍间隔
      const bgInterval = this.#latencyIntervalMs * 5;
      this.#latencyTimer = setInterval(() => {
        const urls = [...this.#wsMap.keys()];
        for (const url of urls) {
          this.testLatency(url).catch(() => {});
        }
      }, bgInterval);
    } else {
      // 回到前台立即测一次，然后恢复正常间隔
      const urls = [...this.#wsMap.keys()];
      for (const url of urls) {
        this.testLatency(url).catch(() => {});
      }
      this.#latencyTimer = setInterval(() => {
        const urls = [...this.#wsMap.keys()];
        for (const url of urls) {
          this.testLatency(url).catch(() => {});
        }
      }, this.#latencyIntervalMs);
    }
  };
}
