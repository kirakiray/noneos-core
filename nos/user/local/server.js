import { getServerList, saveServerList } from "../db.js";

const DEFAULT_SERVERS = ["ws://localhost:8081", "ws://localhost:8082"];
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
   * @returns {Promise<{success: boolean, version: string|null}>} 连接成功返回 { success: true, version }
   */
  async connect(url) {
    // 检查是否已有可用连接
    if (this.#wsMap.has(url)) {
      const existingWs = this.#wsMap.get(url);
      if (
        existingWs.readyState === WebSocket.OPEN ||
        existingWs.readyState === WebSocket.CONNECTING
      ) {
        return { success: true, version: this.#serverVersions.get(url) || null };
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

    const promise = new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let isHandshaked = false;

      const timeout = setTimeout(() => {
        if (!isHandshaked) {
          ws.close();
          const err = new Error("Handshake timeout");
          reject(err);
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
              const version = data.version || null;
              this.#wsMap.set(url, ws);
              this.#serverVersions.set(url, version);

              // 触发握手成功事件
              this.#user._trigger("handshake", {
                url,
                status: "success",
                isAdmin: data.is_admin,
                version,
              });

              // 绑定后续消息处理
              ws.onmessage = (e) => {
                this.#user._trigger("message", {
                  url: url,
                  data: e.data,
                  originalEvent: e,
                });
              };

              // 绑定关闭处理
              ws.onclose = () => {
                this.#wsMap.delete(url);
                this.#serverVersions.delete(url);
                this.#serverCandidateCache.clear(); // 拓扑变化，清空路由缓存
                this.#user._trigger("close", { url: url });
                // 没有活跃连接时自动停止延迟监测
                if (this.#wsMap.size === 0) {
                  this.stopLatencyMonitor();
                }
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

    // 缓存正在进行的连接 Promise
    this.#connectPromises.set(url, promise);

    // 连接完成后清理缓存
    promise.finally(() => {
      this.#connectPromises.delete(url);
    });

    return promise;
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
            unbind();
            resolve(data);
          }
        }
      };

      const unbind = this.#user.bind("message", handler);
      this.sendToServer(url, JSON.stringify(request));

      setTimeout(() => {
        unbind();
        reject(new Error(`Command timed out (type: ${responseType})`));
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
        const { online, sessions, sessionInfo } = await this.queryUserOnline(url, targetUserId);
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

    // 写入缓存
    this.#serverCandidateCache.set(targetUserId, {
      candidates,
      timestamp: Date.now(),
    });

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
      const handler = (e) => {
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
          unbind();
          resolve(resp);
        }
      };

      const unbind = this.#user.bind("message", handler);
      this.sendToServer(url, frame);

      setTimeout(() => {
        unbind();
        reject(new Error("Command timed out (type: relay_response)"));
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
    for (const candidate of candidates) {
      if (candidate.sessions.includes(targetSessionId)) {
        const result = await this.relayToUserViaServer(
          candidate.url,
          targetUserId,
          targetSessionId,
          data,
        );
        return { result, url: candidate.url };
      }
    }

    // 所有服务器上该 session 都不在线
    throw new Error(
      `Session ${targetSessionId} of user ${targetUserId} is not online`,
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
   * @param {number} [timeout=5000] - 超时时间（毫秒）
   * @returns {Promise<{rtt: number, oneWayLatency: number, clientTime: number, serverRecvTime: number, serverSendTime: number, clientRecvTime: number}>}
   */
  async testLatency(url, timeout = 5000) {
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
   * 断开指定服务器的连接
   * @param {string} url - 服务器 WebSocket 地址
   */
  disconnect(url) {
    const ws = this.#wsMap.get(url);
    if (ws) {
      this.#wsMap.delete(url);
      ws.close();
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
