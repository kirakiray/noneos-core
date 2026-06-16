import { BaseUser } from "../base-user.js";

// 公共 STUN 服务器配置
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com" },
];

// WebRTC 重连延迟（毫秒）
const RECONNECT_DELAY = 3000;

/**
 * 远程用户类，代表通过服务器连接的另一个用户
 * 提供查询对方在线状态、发送数据、接收消息的能力
 *
 * 支持 WebRTC P2P 直连：
 * - connectUser() 调用方作为 initiator 立即发起 WebRTC 信令
 * - 信令通过现有服务端 relay 机制转发（data.type === "__webrtc"）
 * - DataChannel 建立后 send() 优先走 P2P，断开时自动回退到 relay
 *
 * 传输模式（transportMode）：
 * - "auto"（默认）：优先 WebRTC，不可用时回退 relay
 * - "relay"：始终使用服务端 relay 转发
 * - "webrtc"：仅使用 WebRTC，DataChannel 不可时 send() 抛出错误
 *
 * 可通过 connectUser(userId, { webrtc: false }) 禁用 WebRTC 初始化，
 * 也可在实例化后通过 setTransportMode() 自由切换模式。
 */
export class RemoteUser extends BaseUser {
  #userId;
  #localUser;
  #isInitiator;
  #transportMode = "auto"; // "auto" | "relay" | "webrtc"

  // WebRTC 相关
  #pc = null; // RTCPeerConnection
  #dc = null; // DataChannel
  #webrtcState = "new"; // "new" | "connecting" | "connected" | "disconnected" | "failed"
  #reconnectTimer = null;
  #peerSessionIds = new Set(); // 已知对方的 sessionId 集合
  #pendingCandidates = []; // remoteDescription 设置前缓存的 ICE candidate
  #destroyed = false;

  /**
   * @param {string} userId - 目标用户的 userId
   * @param {import("./user.js").LocalUser} localUser - 本地用户实例
   * @param {boolean} [initiator=false] - 是否为 WebRTC 发起方
   */
  constructor(userId, localUser, initiator = false) {
    super();
    if (!userId) {
      throw new Error("userId is required");
    }
    this.#userId = userId;
    this.#localUser = localUser;
    this.#isInitiator = initiator;

    if (initiator) {
      // initiator 立即发起 WebRTC 连接（非阻塞）
      this.#initiateWebRTC().catch(() => {});
    }
  }

  /**
   * 获取远程用户的 ID
   */
  get userId() {
    return this.#userId;
  }

  /**
   * 获取当前传输模式
   * @returns {"auto" | "relay" | "webrtc"}
   */
  get transportMode() {
    return this.#transportMode;
  }

  /**
   * 设置传输模式
   * - "auto"：优先 WebRTC，不可用时回退 relay（默认）
   * - "relay"：始终使用服务端 relay 转发
   * - "webrtc"：仅使用 WebRTC，DataChannel 不可用时 send() 抛出错误
   * @param {"auto" | "relay" | "webrtc"} mode
   */
  setTransportMode(mode) {
    if (mode !== "auto" && mode !== "relay" && mode !== "webrtc") {
      throw new Error(`Invalid transport mode: ${mode}`);
    }
    this.#transportMode = mode;
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

  // ========== WebRTC 状态管理 ==========

  /**
   * 更新 WebRTC 状态并触发事件
   */
  #setWebRTCState(state) {
    this.#webrtcState = state;
    this._trigger("webrtc_state", { state });
  }

  /**
   * 创建 RTCPeerConnection 并绑定事件
   */
  #createPeerConnection() {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.oniceconnectionstatechange = () => {
      const iceState = pc.iceConnectionState;
      if (iceState === "connected" || iceState === "completed") {
        // DataChannel open 事件会单独处理 connected 状态
        // 这里仅作为备份，防止 onopen 未触发
        if (this.#dc && this.#dc.readyState === "open") {
          this.#setWebRTCState("connected");
        }
      } else if (iceState === "disconnected") {
        this.#setWebRTCState("disconnected");
        this.#scheduleReconnect();
      } else if (iceState === "failed") {
        this.#setWebRTCState("failed");
        this.#scheduleReconnect();
      }
    };

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.#sendSignal({
          signalType: "ice_candidate",
          candidate: event.candidate.toJSON(),
        }).catch(() => {});
      }
    };

    // answerer 端通过 ondatachannel 接收 DataChannel
    pc.ondatachannel = (event) => {
      this.#setupDataChannel(event.channel);
    };

    return pc;
  }

  /**
   * 配置 DataChannel 事件
   */
  #setupDataChannel(dc) {
    this.#dc = dc;

    dc.onopen = () => {
      this.#setWebRTCState("connected");
    };

    dc.onclose = () => {
      this.#setWebRTCState("disconnected");
      this.#scheduleReconnect();
    };

    dc.onmessage = (event) => {
      this.#handleDataChannelMessage(event.data);
    };
  }

  /**
   * initiator 端发起 WebRTC 连接
   */
  async #initiateWebRTC() {
    if (this.#destroyed) return;

    try {
      this.#setWebRTCState("connecting");
      this.#pc = this.#createPeerConnection();

      // initiator 创建 DataChannel
      const dc = this.#pc.createDataChannel("data", { ordered: true });
      this.#setupDataChannel(dc);

      const offer = await this.#pc.createOffer();
      await this.#pc.setLocalDescription(offer);

      await this.#sendSignal({
        signalType: "offer",
        sdp: this.#pc.localDescription.toJSON(),
      });
    } catch {
      this.#setWebRTCState("failed");
      // 静默回退到 relay，不抛出异常
    }
  }

  /**
   * 通过服务端 relay 发送信令数据
   * 信令会发送到所有已知的对方 sessionId
   */
  async #sendSignal(signalData) {
    const data = { type: "__webrtc", ...signalData };

    let sessionIds = [...this.#peerSessionIds];
    if (sessionIds.length === 0) {
      try {
        sessionIds = await this.getSessionIds();
        for (const sid of sessionIds) {
          this.#peerSessionIds.add(sid);
        }
      } catch {
        return;
      }
    }

    const sendPromises = sessionIds.map((sid) =>
      this.#localUser.server
        .sendToUser(this.#userId, sid, data)
        .catch(() => {}),
    );
    await Promise.allSettled(sendPromises);
  }

  /**
   * 处理收到的信令消息（由 LocalUser 的 relay 分发调用）
   * @param {Object} signal - 信令数据 { type, signalType, sdp?, candidate? }
   * @param {string} fromSessionId - 发送方的 sessionId
   */
  async _handleSignal(signal, fromSessionId) {
    if (this.#destroyed) return;

    // 记录对方的 sessionId，用于后续信令回复
    if (fromSessionId) {
      this.#peerSessionIds.add(fromSessionId);
    }

    if (signal.signalType === "offer") {
      await this.#handleOffer(signal);
    } else if (signal.signalType === "answer") {
      await this.#handleAnswer(signal);
    } else if (signal.signalType === "ice_candidate") {
      await this.#handleIceCandidate(signal);
    }
  }

  /**
   * 处理 offer 信令（answerer 端）
   */
  async #handleOffer(signal) {
    if (this.#isInitiator) {
      // Glare 处理：双方同时发起时，userId 较大的一方让步成为 answerer
      if (this.#localUser.userId > this.#userId) {
        // 我方让步，转为 answerer
        this.#isInitiator = false;
        this.#cleanupWebRTC();
      } else {
        // 对方让步，忽略此 offer
        return;
      }
    }

    try {
      if (!this.#pc) {
        this.#setWebRTCState("connecting");
        this.#pc = this.#createPeerConnection();
      }

      await this.#pc.setRemoteDescription(signal.sdp);

      // 设置 remote description 后，处理缓存的 ICE candidate
      await this.#flushPendingCandidates();

      const answer = await this.#pc.createAnswer();
      await this.#pc.setLocalDescription(answer);

      await this.#sendSignal({
        signalType: "answer",
        sdp: this.#pc.localDescription.toJSON(),
      });
    } catch {
      this.#setWebRTCState("failed");
    }
  }

  /**
   * 处理 answer 信令（initiator 端）
   */
  async #handleAnswer(signal) {
    try {
      if (this.#pc && this.#pc.signalingState !== "stable") {
        await this.#pc.setRemoteDescription(signal.sdp);
        await this.#flushPendingCandidates();
      }
    } catch {
      // 静默处理
    }
  }

  /**
   * 处理 ICE candidate 信令
   */
  async #handleIceCandidate(signal) {
    try {
      if (this.#pc && this.#pc.remoteDescription) {
        await this.#pc.addIceCandidate(signal.candidate);
      } else {
        // remoteDescription 还没设置，缓存起来
        this.#pendingCandidates.push(signal.candidate);
      }
    } catch {
      // 静默处理
    }
  }

  /**
   * 刷新缓存的 ICE candidate
   */
  async #flushPendingCandidates() {
    const candidates = this.#pendingCandidates;
    this.#pendingCandidates = [];
    for (const candidate of candidates) {
      try {
        await this.#pc.addIceCandidate(candidate);
      } catch {
        // 静默处理
      }
    }
  }

  /**
   * 处理 DataChannel 收到的消息
   * 触发与 relay 消息格式一致的 "message" 事件
   */
  #handleDataChannelMessage(rawData) {
    try {
      const envelope =
        typeof rawData === "string" ? JSON.parse(rawData) : null;
      if (envelope && envelope.type === "__webrtc_data") {
        this._trigger("message", {
          fromUserId: envelope.fromUserId,
          fromSessionId: envelope.fromSessionId,
          data: envelope.data,
        });
      }
    } catch {
      // 非预期格式，忽略
    }
  }

  /**
   * 安排重连
   */
  #scheduleReconnect() {
    if (this.#reconnectTimer || this.#destroyed) return;
    this.#reconnectTimer = setTimeout(() => {
      this.#reconnectTimer = null;
      if (this.#destroyed) return;
      // 只有 initiator 主动重连，避免双方同时重连
      if (this.#isInitiator) {
        this.#cleanupWebRTC();
        this.#initiateWebRTC().catch(() => {});
      }
    }, RECONNECT_DELAY);
  }

  /**
   * 清理 WebRTC 资源
   */
  #cleanupWebRTC() {
    if (this.#dc) {
      this.#dc.onopen = null;
      this.#dc.onclose = null;
      this.#dc.onmessage = null;
      try {
        this.#dc.close();
      } catch {}
      this.#dc = null;
    }
    if (this.#pc) {
      this.#pc.oniceconnectionstatechange = null;
      this.#pc.onicecandidate = null;
      this.#pc.ondatachannel = null;
      try {
        this.#pc.close();
      } catch {}
      this.#pc = null;
    }
    this.#pendingCandidates = [];
  }

  /**
   * 检查数据是否为二进制类型（无法通过 DataChannel JSON 信封发送）
   */
  #isBinaryData(data) {
    return (
      data instanceof ArrayBuffer ||
      ArrayBuffer.isView(data) ||
      data instanceof Blob
    );
  }

  /**
   * 检查 WebRTC DataChannel 是否可用
   */
  get #isDataChannelOpen() {
    return this.#dc != null && this.#dc.readyState === "open";
  }

  /**
   * 发送数据给对方
   * 根据当前 transportMode 选择传输方式：
   * - "auto"（默认）：WebRTC DataChannel 可用时优先走 P2P，否则回退 relay
   * - "relay"：始终走服务端 relay
   * - "webrtc"：仅走 WebRTC，DataChannel 不可用时抛出错误
   *
   * 二进制数据在 "auto" 模式下始终走 relay（DataChannel 信封使用 JSON 格式）。
   * @param {string} sessionId - 目标会话 ID（走 WebRTC 时仅用于事件 detail）
   * @param {*} data - 要发送的数据（JSON 可序列化值或二进制数据）
   * @returns {Promise<Object>} 发送结果
   */
  async send(sessionId, data) {
    // "relay" 模式：始终走服务端转发
    if (this.#transportMode === "relay") {
      return this.#localUser.server.sendToUser(this.#userId, sessionId, data);
    }

    // "webrtc" 模式：仅走 WebRTC，不可用则抛错
    if (this.#transportMode === "webrtc") {
      if (!this.#isDataChannelOpen) {
        throw new Error("WebRTC DataChannel is not open");
      }
      if (this.#isBinaryData(data)) {
        throw new Error("Binary data is not supported in webrtc-only mode");
      }
      const envelope = JSON.stringify({
        type: "__webrtc_data",
        fromUserId: this.#localUser.userId,
        fromSessionId: this.#localUser.sessionId,
        data,
      });
      this.#dc.send(envelope);
      return { status: "ok", via: "webrtc" };
    }

    // "auto" 模式：优先 WebRTC DataChannel（仅限 JSON 可序列化数据）
    if (this.#isDataChannelOpen && !this.#isBinaryData(data)) {
      try {
        const envelope = JSON.stringify({
          type: "__webrtc_data",
          fromUserId: this.#localUser.userId,
          fromSessionId: this.#localUser.sessionId,
          data,
        });
        this.#dc.send(envelope);
        return { status: "ok", via: "webrtc" };
      } catch {
        // DataChannel 发送失败，回退到 relay
      }
    }

    // 回退到服务端 relay
    return this.#localUser.server.sendToUser(this.#userId, sessionId, data);
  }
}
