import { BaseUser } from "../base-user.js";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com" },
];

const RECONNECT_DELAY_MS = 2000;

/**
 * 远程用户类，代表通过服务器连接的另一个用户
 * 提供查询对方在线状态、发送数据、接收消息的能力
 * 在连接建立后会尝试通过 WebRTC DataChannel 进行 P2P 通信，
 * 失败或尚未建立时自动回退到服务器 relay
 */
export class RemoteUser extends BaseUser {
  #userId;
  #localUser;
  #isInitiator;
  #connections = new Map(); // sessionId -> { pc, dataChannel, pendingCandidates }
  #reconnectTimers = new Map(); // sessionId -> timer
  #webrtcState = "connecting";
  #initError = false;

  /**
   * @param {string} userId - 目标用户的 userId
   * @param {import("./user.js").LocalUser} localUser - 本地用户实例
   * @param {boolean} [isInitiator=false] - 是否由当前端主动发起 WebRTC 连接
   * @param {"auto"|"relay"} [mode="auto"] - 连接模式：auto 自动尝试 WebRTC，relay 仅使用服务器转发
   */
  constructor(userId, localUser, isInitiator = false, mode = "auto") {
    super();
    if (!userId) {
      throw new Error("userId is required");
    }
    this.#userId = userId;
    this.#localUser = localUser;
    this.#isInitiator = isInitiator;

    if (isInitiator && mode !== "relay") {
      this.#startInitiatorConnections();
    } else {
      this.#webrtcState = "disconnected";
    }
  }

  /**
   * 获取远程用户的 ID
   */
  get userId() {
    return this.#userId;
  }

  /**
   * 获取当前 WebRTC 连接状态
   */
  get webrtcState() {
    return this.#webrtcState;
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
   * 优先使用已建立的 WebRTC DataChannel；否则回退到服务器 relay
   * @param {string} sessionId - 目标会话 ID
   * @param {*} data - 要发送的数据（JSON 可序列化值或二进制数据）
   * @returns {Promise<Object>} 发送结果
   */
  async send(sessionId, data) {
    const conn = this.#findBestConnection(sessionId);
    if (conn && conn.dataChannel && conn.dataChannel.readyState === "open") {
      try {
        this.#sendViaDataChannel(conn.dataChannel, data);
        return { status: "ok", via: "webrtc" };
      } catch {
        // 发送失败则静默回退到 relay
      }
    }

    return this.#localUser.server.sendToUser(this.#userId, sessionId, data);
  }

  /**
   * 处理来自对方的 WebRTC 信令消息
   * 由 LocalUser 在收到 relay 消息后调用
   * @param {Object} signal - 信令消息体
   * @param {string} remoteSessionId - 对方的 sessionId
   */
  _handleSignal(signal, remoteSessionId) {
    if (!signal || typeof signal.signalType !== "string") return;

    switch (signal.signalType) {
      case "offer":
        this.#handleOffer(remoteSessionId, signal.sdp);
        break;
      case "answer":
        this.#handleAnswer(remoteSessionId, signal.sdp);
        break;
      case "ice_candidate":
        this.#handleIceCandidate(
          remoteSessionId,
          signal.candidate,
          signal.sdpMid,
          signal.sdpMLineIndex,
        );
        break;
    }
  }

  /**
   * 主动发起方：查询对方所有 sessionId 并为每个 session 创建连接
   */
  async #startInitiatorConnections() {
    try {
      this.#setState("connecting");
      const sessionIds = await this.getSessionIds();
      for (const sessionId of sessionIds) {
        this.#createInitiatorConnection(sessionId);
      }
      if (sessionIds.length === 0) {
        this.#initError = true;
        this.#updateState();
      }
    } catch {
      this.#initError = true;
      this.#setState("failed");
    }
  }

  /**
   * 主动发起方：为指定 sessionId 创建 RTCPeerConnection、DataChannel 并发送 offer
   * @param {string} remoteSessionId
   */
  async #createInitiatorConnection(remoteSessionId) {
    if (this.#connections.has(remoteSessionId)) {
      return;
    }

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const dataChannel = pc.createDataChannel("noneos-p2p", {
      ordered: true,
    });

    const conn = { pc, dataChannel, pendingCandidates: [] };
    this.#connections.set(remoteSessionId, conn);

    this.#setupDataChannel(dataChannel, remoteSessionId);
    this.#setupPeerConnection(pc, remoteSessionId);

    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      this.#sendSignal(remoteSessionId, {
        signalType: "offer",
        sdp: pc.localDescription.sdp,
      });
    } catch {
      this.#cleanupConnection(remoteSessionId);
      this.#updateState();
    }
  }

  /**
   * 接收方：处理 offer 并创建 answer
   * @param {string} remoteSessionId
   * @param {string} sdp
   */
  async #handleOffer(remoteSessionId, sdp) {
    if (!sdp) return;

    const existing = this.#connections.get(remoteSessionId);
    if (existing) {
      // 如果已有打开的连接，忽略新的 offer
      if (existing.dataChannel?.readyState === "open") return;
      // 如果当前端也是 initiator 且已发出 offer，用 sessionId 作为 tiebreaker
      // 避免双方都当 initiator 导致 DataChannel 冲突
      if (existing.pc?.signalingState === "have-local-offer") {
        const localSessionId = this.#localUser.sessionId;
        if (localSessionId < remoteSessionId) {
          // 本端 sessionId 较小，保持 initiator，忽略对方 offer
          return;
        }
      }
    }

    // 关闭旧连接并创建 answerer
    this.#cleanupConnection(remoteSessionId);
    this.#cancelReconnect(remoteSessionId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const conn = { pc, dataChannel: null, pendingCandidates: [] };
    this.#connections.set(remoteSessionId, conn);

    pc.ondatachannel = (event) => {
      const dataChannel = event.channel;
      conn.dataChannel = dataChannel;
      this.#setupDataChannel(dataChannel, remoteSessionId);
    };

    this.#setupPeerConnection(pc, remoteSessionId);

    try {
      await pc.setRemoteDescription({ type: "offer", sdp });
      await this.#drainPendingCandidates(remoteSessionId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      this.#sendSignal(remoteSessionId, {
        signalType: "answer",
        sdp: pc.localDescription.sdp,
      });
      this.#setState("connecting");
    } catch {
      this.#cleanupConnection(remoteSessionId);
      this.#updateState();
    }
  }

  /**
   * 主动发起方：处理 answer
   * @param {string} remoteSessionId
   * @param {string} sdp
   */
  async #handleAnswer(remoteSessionId, sdp) {
    if (!sdp) return;
    const conn = this.#connections.get(remoteSessionId);
    if (!conn || !conn.pc) return;

    try {
      if (conn.pc.signalingState === "have-local-offer") {
        await conn.pc.setRemoteDescription({ type: "answer", sdp });
        await this.#drainPendingCandidates(remoteSessionId);
      }
    } catch {
      this.#cleanupConnection(remoteSessionId);
      this.#updateState();
    }
  }

  /**
   * 处理 ICE candidate
   * @param {string} remoteSessionId
   * @param {string} candidate
   * @param {string} [sdpMid]
   * @param {number} [sdpMLineIndex]
   */
  async #handleIceCandidate(remoteSessionId, candidate, sdpMid, sdpMLineIndex) {
    const conn = this.#connections.get(remoteSessionId);
    if (!conn || !conn.pc) return;

    const candidateInit = { candidate, sdpMid, sdpMLineIndex };

    // 如果 remote description 尚未设置，先缓存 candidate
    if (!conn.pc.remoteDescription || !conn.pc.remoteDescription.sdp) {
      conn.pendingCandidates.push(candidateInit);
      return;
    }

    try {
      await conn.pc.addIceCandidate(candidateInit);
    } catch {
      // 静默忽略无效 candidate
    }
  }

  /**
   * 将缓存的 ICE candidate 添加到 PeerConnection
   * @param {string} remoteSessionId
   */
  async #drainPendingCandidates(remoteSessionId) {
    const conn = this.#connections.get(remoteSessionId);
    if (!conn || !conn.pc) return;

    while (conn.pendingCandidates.length > 0) {
      const candidateInit = conn.pendingCandidates.shift();
      try {
        await conn.pc.addIceCandidate(candidateInit);
      } catch {
        // 静默忽略
      }
    }
  }

  /**
   * 配置 DataChannel 事件
   * @param {RTCDataChannel} dataChannel
   * @param {string} remoteSessionId
   */
  #setupDataChannel(dataChannel, remoteSessionId) {
    dataChannel.onopen = () => {
      this.#cancelReconnect(remoteSessionId);
      this.#updateState();
    };

    dataChannel.onmessage = (event) => {
      let payload = event.data;
      if (typeof payload === "string") {
        try {
          payload = JSON.parse(payload);
        } catch {
          // 保持原始字符串
        }
      }
      this._trigger("message", {
        fromUserId: this.#userId,
        fromSessionId: remoteSessionId,
        data: payload,
      });
    };

    dataChannel.onclose = () => {
      this.#updateState();
      this.#scheduleReconnect(remoteSessionId);
    };

    dataChannel.onerror = () => {
      this.#updateState();
      this.#scheduleReconnect(remoteSessionId);
    };
  }

  /**
   * 配置 RTCPeerConnection 事件
   * @param {RTCPeerConnection} pc
   * @param {string} remoteSessionId
   */
  #setupPeerConnection(pc, remoteSessionId) {
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.#sendSignal(remoteSessionId, {
          signalType: "ice_candidate",
          candidate: event.candidate.candidate,
          sdpMid: event.candidate.sdpMid,
          sdpMLineIndex: event.candidate.sdpMLineIndex,
        });
      }
    };

    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      if (state === "disconnected" || state === "failed" || state === "closed") {
        this.#updateState();
        this.#scheduleReconnect(remoteSessionId);
      } else if (state === "connected" || state === "completed") {
        this.#cancelReconnect(remoteSessionId);
        this.#updateState();
      }
    };

    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "disconnected" || state === "failed" || state === "closed") {
        this.#updateState();
        this.#scheduleReconnect(remoteSessionId);
      } else if (state === "connected") {
        this.#cancelReconnect(remoteSessionId);
        this.#updateState();
      }
    };
  }

  /**
   * 通过 relay 发送 WebRTC 信令给对方
   * @param {string} remoteSessionId
   * @param {Object} signalPayload
   */
  #sendSignal(remoteSessionId, signalPayload) {
    const data = {
      type: "__webrtc",
      ...signalPayload,
    };
    this.#localUser.server
      .sendToUser(this.#userId, remoteSessionId, data)
      .catch(() => {
        // 信令发送失败，依赖后续重连
      });
  }

  /**
   * 通过 DataChannel 发送数据
   * @param {RTCDataChannel} dataChannel
   * @param {*} data
   */
  #sendViaDataChannel(dataChannel, data) {
    if (typeof data === "string" || this.#isBinaryData(data)) {
      dataChannel.send(data);
    } else {
      dataChannel.send(JSON.stringify(data));
    }
  }

  /**
   * 判断数据是否为二进制类型
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
   * 查找可用的连接
   * 优先匹配传入的 sessionId，否则返回任意可用的连接
   * @param {string} sessionId
   * @returns {Object|null}
   */
  #findBestConnection(sessionId) {
    const exact = this.#connections.get(sessionId);
    if (exact && exact.dataChannel?.readyState === "open") {
      return exact;
    }
    for (const conn of this.#connections.values()) {
      if (conn.dataChannel?.readyState === "open") {
        return conn;
      }
    }
    return null;
  }

  /**
   * 安排重连
   * @param {string} remoteSessionId
   */
  #scheduleReconnect(remoteSessionId) {
    if (this.#reconnectTimers.has(remoteSessionId)) return;

    const timer = setTimeout(() => {
      this.#reconnectTimers.delete(remoteSessionId);
      this.#cleanupConnection(remoteSessionId);
      if (this.#isInitiator) {
        this.#createInitiatorConnection(remoteSessionId);
      }
    }, RECONNECT_DELAY_MS);

    this.#reconnectTimers.set(remoteSessionId, timer);
  }

  /**
   * 取消指定 session 的重连定时器
   * @param {string} remoteSessionId
   */
  #cancelReconnect(remoteSessionId) {
    const timer = this.#reconnectTimers.get(remoteSessionId);
    if (timer) {
      clearTimeout(timer);
      this.#reconnectTimers.delete(remoteSessionId);
    }
  }

  /**
   * 清理并关闭指定 session 的连接
   * @param {string} remoteSessionId
   */
  #cleanupConnection(remoteSessionId) {
    const conn = this.#connections.get(remoteSessionId);
    if (!conn) return;

    if (conn.dataChannel) {
      try {
        conn.dataChannel.close();
      } catch {}
    }
    if (conn.pc) {
      try {
        conn.pc.close();
      } catch {}
    }
    this.#connections.delete(remoteSessionId);
  }

  /**
   * 根据当前所有连接的状态更新并触发 webrtc_state 事件
   */
  #updateState() {
    let hasOpen = false;
    let hasConnecting = false;

    for (const conn of this.#connections.values()) {
      if (conn.dataChannel?.readyState === "open") {
        hasOpen = true;
      } else if (
        conn.pc &&
        conn.pc.connectionState !== "closed" &&
        conn.pc.connectionState !== "failed"
      ) {
        hasConnecting = true;
      }
    }

    if (hasOpen) {
      this.#setState("connected");
    } else if (hasConnecting || this.#isInitiator && !this.#initError) {
      this.#setState("connecting");
    } else if (this.#connections.size === 0 && this.#initError) {
      this.#setState("failed");
    } else {
      this.#setState("disconnected");
    }
  }

  /**
   * 设置 WebRTC 状态并触发事件
   * @param {"connecting"|"connected"|"disconnected"|"failed"} state
   */
  #setState(state) {
    if (this.#webrtcState === state) return;
    this.#webrtcState = state;
    this._trigger("webrtc_state", { state });
  }
}
