/**
 * RTCManager - 管理本地用户与其他用户 session 之间的 WebRTC 直连。
 *
 * 设计原则：
 * - 服务端不做任何改动，RTC 信令（SDP/ICE）通过现有的服务器 relay 中转。
 * - 每条 RTC 连接以 "userId:sessionId" 为 key，由当前标签页独立维护。
 * - 连接在首次需要时（RemoteUser.send）后台发起，不阻塞消息发送。
 * - 任何环节失败都静默放弃，业务层继续走服务器中转兜底。
 */

// 默认 ICE 服务器配置：使用公共 STUN 服务器支持 NAT 穿透打洞。
// 如需更严格的 NAT 环境（对称型 NAT 等）支持，应追加 TURN 服务器。
const DEFAULT_ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
];

// localStorage key，用于持久化用户自定义 ICE 配置（供 rtc-tool 等工具写入）。
const ICE_STORAGE_KEY = "noneos:rtc:ice_servers";

// 从 localStorage 读取用户自定义配置，解析失败或为空则返回默认配置。
const loadStoredIceServers = () => {
  try {
    const raw = localStorage.getItem(ICE_STORAGE_KEY);
    if (!raw) return DEFAULT_ICE_SERVERS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      return DEFAULT_ICE_SERVERS;
    }
    // 仅保留启用的服务器，并映射为 RTC 标准格式
    const servers = parsed
      .filter((item) => item && item.enabled !== false && item.urls)
      .map((item) => {
        const out = { urls: item.urls };
        if (item.username) out.username = item.username;
        if (item.credential) out.credential = item.credential;
        return out;
      });
    return servers.length > 0 ? servers : DEFAULT_ICE_SERVERS;
  } catch {
    return DEFAULT_ICE_SERVERS;
  }
};

export class RTCManager {
  #user;
  #peers = new Map(); // key: "userId:sessionId" -> { pc, dc, state }
  #connectPromises = new Map(); // key -> Promise，防止并发重复建连
  #iceServers = DEFAULT_ICE_SERVERS; // 当前生效的 ICE 服务器配置

  /**
   * @param {import("./user.js").LocalUser} user - 本地用户实例
   */
  constructor(user) {
    this.#user = user;
    // 构造时从 localStorage 读取用户自定义配置（若有）
    this.#iceServers = loadStoredIceServers();
  }

  /**
   * 设置 ICE 服务器配置（运行时即时生效，对后续新建的 RTCPeerConnection 生效）。
   * 已建立的连接不受影响，会在重连时采用新配置。
   * @param {Array<Object>} servers - ICE 服务器数组，每项形如 { urls, username?, credential? }
   */
  setIceServers(servers) {
    if (!Array.isArray(servers) || servers.length === 0) {
      this.#iceServers = DEFAULT_ICE_SERVERS;
      return;
    }
    this.#iceServers = servers;
  }

  /**
   * 获取当前生效的 ICE 服务器配置。
   * @returns {Array<Object>}
   */
  getIceServers() {
    return this.#iceServers;
  }

  /**
   * 获取指定目标 session 的 RTCDataChannel（若已就绪）
   * @returns {RTCDataChannel | undefined}
   */
  getChannel(userId, sessionId) {
    const key = this.#key(userId, sessionId);
    const peer = this.#peers.get(key);
    return peer?.dc;
  }

  /**
   * 发起与指定用户 session 的 RTC 连接（幂等）
   * @param {string} userId - 目标用户 ID
   * @param {string} sessionId - 目标会话 ID
   */
  async connect(userId, sessionId) {
    const key = this.#key(userId, sessionId);

    const existing = this.#peers.get(key);
    if (existing && existing.state !== "failed") {
      return;
    }

    if (this.#connectPromises.has(key)) {
      return this.#connectPromises.get(key);
    }

    const promise = this.#doConnect(userId, sessionId).finally(() => {
      this.#connectPromises.delete(key);
    });

    this.#connectPromises.set(key, promise);
    return promise;
  }

  /**
   * 处理收到的 RTC 信令（offer/answer/ice）
   * @param {string} fromUserId - 发送方用户 ID
   * @param {string} fromSessionId - 发送方会话 ID
   * @param {Object} signal - 信令内容
   */
  async handleSignal(fromUserId, fromSessionId, signal) {
    const key = this.#key(fromUserId, fromSessionId);

    try {
      if (signal.type === "offer") {
        await this.#handleOffer(key, fromUserId, fromSessionId, signal);
      } else if (signal.type === "answer") {
        await this.#handleAnswer(key, signal);
      } else if (signal.type === "ice") {
        await this.#handleIce(key, signal);
      }
    } catch (err) {
      console.warn("[RTCManager] handleSignal failed:", err);
      this.#peers.delete(key);
    }
  }

  async #doConnect(userId, sessionId) {
    const key = this.#key(userId, sessionId);

    const pc = new RTCPeerConnection({ iceServers: this.#iceServers });
    const dc = pc.createDataChannel("noneos", { ordered: true });

    this.#setupDataChannel(dc, userId, sessionId);
    this.#setupPeerConnection(pc, userId, sessionId);

    this.#peers.set(key, { pc, dc, state: "connecting" });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await this.#sendSignal(userId, sessionId, { type: "offer", sdp: offer.sdp });
  }

  async #handleOffer(key, userId, sessionId, signal) {
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers });
    this.#setupPeerConnection(pc, userId, sessionId);

    pc.ondatachannel = (event) => {
      const dc = event.channel;
      this.#setupDataChannel(dc, userId, sessionId);
      const peer = this.#peers.get(key);
      if (peer) peer.dc = dc;
    };

    await pc.setRemoteDescription(
      new RTCSessionDescription({ type: "offer", sdp: signal.sdp }),
    );

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    this.#peers.set(key, { pc, dc: null, state: "connecting" });

    await this.#sendSignal(userId, sessionId, {
      type: "answer",
      sdp: answer.sdp,
    });
  }

  async #handleAnswer(key, signal) {
    const peer = this.#peers.get(key);
    if (!peer) return;

    await peer.pc.setRemoteDescription(
      new RTCSessionDescription({ type: "answer", sdp: signal.sdp }),
    );
  }

  async #handleIce(key, signal) {
    const peer = this.#peers.get(key);
    if (!peer) return;

    await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
  }

  #setupPeerConnection(pc, userId, sessionId) {
    const key = this.#key(userId, sessionId);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.#sendSignal(userId, sessionId, {
          type: "ice",
          candidate: event.candidate.toJSON(),
        }).catch(() => {});
      }
    };

    pc.onconnectionstatechange = () => {
      const peer = this.#peers.get(key);
      if (!peer) return;

      if (pc.connectionState === "connected") {
        peer.state = "connected";
      } else if (
        ["failed", "disconnected", "closed"].includes(pc.connectionState)
      ) {
        this.#peers.delete(key);
      }
    };
  }

  #setupDataChannel(dc, userId, sessionId) {
    const key = this.#key(userId, sessionId);

    dc.onopen = () => {
      const peer = this.#peers.get(key);
      if (peer) peer.state = "connected";
      this.#user._trigger("rtc_state", {
        userId,
        sessionId,
        state: "connected",
      });
    };

    dc.onmessage = (event) => {
      this.#user._trigger("rtc_message", {
        fromUserId: userId,
        fromSessionId: sessionId,
        data: event.data,
      });
    };

    dc.onclose = () => {
      this.#peers.delete(key);
      this.#user._trigger("rtc_state", {
        userId,
        sessionId,
        state: "disconnected",
      });
    };

    dc.onerror = () => {
      this.#peers.delete(key);
      this.#user._trigger("rtc_state", {
        userId,
        sessionId,
        state: "disconnected",
      });
    };
  }

  async #sendSignal(targetUserId, targetSessionId, signal) {
    const data = {
      type: "rtc_signal",
      from_session_id: this.#user.sessionId,
      signal,
    };
    await this.#user.server.sendToUser(targetUserId, targetSessionId, data);
  }

  #key(userId, sessionId) {
    return `${userId}:${sessionId}`;
  }
}
