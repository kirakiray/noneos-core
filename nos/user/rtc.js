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
  // key: "userId:sessionId" -> { pc, dc, state, pendingCandidates, polite }
  // pendingCandidates: 收到时尚未 setRemoteDescription 时缓冲的 ICE 候选
  // polite: Perfect Negotiation 中本端是否为让步方（glare 时回退自身 offer）
  #peers = new Map();
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

    // 已连接 / DataChannel 已开 → 不重复建连
    const existing = this.#peers.get(key);
    if (existing?.state === "connected") return;
    if (existing?.dc?.readyState === "open") return;
    // 已有 PC 且正处于协商中（have-local-offer / have-remote-offer）→ 不打断
    if (
      existing?.pc &&
      existing.pc.signalingState !== "stable" &&
      existing.pc.signalingState !== "closed"
    ) {
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
   * 处理收到的 RTC 信令（offer/answer/ice）。
   * 任何信令处理失败都不会立即销毁 peer —— 仅记录告警，
   * 真正不可恢复（PC 处于 closed/failed）时才清理。
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
      // 仅在 PC 真正不可恢复时清理；乱序/状态错误等可恢复情况保留 peer，
      // 让后续信令仍能继续推进（或触发重连）。
      const peer = this.#peers.get(key);
      if (peer?.pc && ["closed", "failed"].includes(peer.pc.connectionState)) {
        this.#peers.delete(key);
      }
    }
  }

  /**
   * Perfect Negotiation：依据双方 userId 字典序决定本端是否为 polite 方。
   * polite 方在 glare（双方同时发 offer）时回退自己的 offer 接受对方；
   * impolite 方坚持自己的 offer，丢弃对方。
   * 两侧 userId 比较结果互为反，保证一端 polite 一端 impolite，永不死锁。
   * @param {string} otherUserId
   * @returns {boolean}
   */
  #isPolite(otherUserId) {
    return this.#user.userId < otherUserId;
  }

  /**
   * 创建新的 RTCPeerConnection 并装配事件处理。
   * @param {string} userId
   * @param {string} sessionId
   * @returns {RTCPeerConnection}
   */
  #createPeerConnection(userId, sessionId) {
    const key = this.#key(userId, sessionId);
    const pc = new RTCPeerConnection({ iceServers: this.#iceServers });

    this.#setupPeerConnection(pc, userId, sessionId);

    // 接收对端主动创建的 DataChannel（对端为 offer 方时）
    pc.ondatachannel = (event) => {
      const dc = event.channel;
      this.#setupDataChannel(dc, userId, sessionId);
      const peer = this.#peers.get(key);
      if (peer) peer.dc = dc;
    };

    return pc;
  }

  async #doConnect(userId, sessionId) {
    const key = this.#key(userId, sessionId);

    const pc = this.#createPeerConnection(userId, sessionId);
    const dc = pc.createDataChannel("noneos", { ordered: true });
    this.#setupDataChannel(dc, userId, sessionId);

    // 提前写 #peers：保留可能存在的 pendingCandidates（早到的 ICE 候选），
    // 让后续 #handleIce / onicecandidate 能立即查到 peer，避免候选丢失。
    const previous = this.#peers.get(key);
    this.#peers.set(key, {
      pc,
      dc,
      state: "connecting",
      pendingCandidates: previous?.pendingCandidates ?? [],
      polite: this.#isPolite(userId),
    });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await this.#sendSignal(userId, sessionId, { type: "offer", sdp: offer.sdp });
  }

  /**
   * 处理收到的 offer。包含 Perfect Negotiation 的 glare 处理：
   * - 若本地已有 PC 处于 have-local-offer（即也刚发了 offer）：
   *   * polite 方：rollback 本地 offer，沿用同一 PC 接收对方 offer；
   *   * impolite 方：直接忽略对方 offer，等对方回退并接受自己的。
   * - 否则：复用已有 PC（stable）或新建 PC。
   * 写 #peers 时机提前到 setRemoteDescription 之前，避免早到的 ICE 候选丢失。
   */
  async #handleOffer(key, userId, sessionId, signal) {
    const polite = this.#isPolite(userId);
    let peer = this.#peers.get(key);

    // 已通过 DataChannel 直连成功，忽略重复 offer
    if (peer?.dc?.readyState === "open") {
      return;
    }

    // Glare：本地已发出 offer（have-local-offer）
    if (peer?.pc && peer.pc.signalingState === "have-local-offer") {
      if (!polite) {
        // impolite 方坚持自己的 offer，忽略对方
        return;
      }
      // polite 方回退自己的 offer，沿用同一 PC 后续 setRemoteDescription(对方 offer)
      try {
        await peer.pc.setLocalDescription({ type: "rollback" });
        peer.dc = null; // 旧 DC 属于已回滚的 offer，置空等对端 ondatachannel
      } catch (err) {
        console.warn("[RTCManager] rollback local offer failed:", err);
        return;
      }
    } else if (!peer?.pc || peer.pc.connectionState === "closed") {
      // 无可用 PC：新建并写入 #peers（提前写入，确保并发 ICE 能查到）
      const pc = this.#createPeerConnection(userId, sessionId);
      peer = {
        pc,
        dc: peer?.dc ?? null,
        state: "connecting",
        pendingCandidates: peer?.pendingCandidates ?? [],
        polite,
      };
      this.#peers.set(key, peer);
    }

    // 此时 peer.pc 必然存在且处于 stable（已 rollback 或刚创建）
    try {
      await peer.pc.setRemoteDescription(
        new RTCSessionDescription({ type: "offer", sdp: signal.sdp }),
      );
      // flush 在 remoteDescription 为 null 期间缓冲的 ICE 候选
      await this.#flushPendingCandidates(peer);

      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);

      await this.#sendSignal(userId, sessionId, {
        type: "answer",
        sdp: answer.sdp,
      });
    } catch (err) {
      console.warn("[RTCManager] handleOffer processing failed:", err);
    }
  }

  async #handleAnswer(key, signal) {
    const peer = this.#peers.get(key);
    if (!peer?.pc) return;

    // 仅在 have-local-offer 时接受 answer；stable/have-remote-offer 收到 answer 是
    // 乱序或 glare 残留，忽略即可，不抛错以免触发外层 catch 的错误处理。
    if (peer.pc.signalingState !== "have-local-offer") {
      return;
    }

    try {
      await peer.pc.setRemoteDescription(
        new RTCSessionDescription({ type: "answer", sdp: signal.sdp }),
      );
      await this.#flushPendingCandidates(peer);
    } catch (err) {
      console.warn("[RTCManager] handleAnswer failed:", err);
    }
  }

  /**
   * 处理收到的 ICE 候选。
   * 若 peer 尚未创建 / remoteDescription 为 null（包括 have-local-offer 的 glare 阶段），
   * 把候选缓冲进 peer.pendingCandidates，等 setRemoteDescription 完成后再 flush。
   * 信令经服务器中转不保证顺序，此机制是必须的。
   */
  async #handleIce(key, signal) {
    let peer = this.#peers.get(key);

    // peer 尚不存在（极少数情况：ICE 早于 offer 到达）→ 预建占位 peer 缓冲候选
    if (!peer) {
      peer = {
        pc: null,
        dc: null,
        state: "connecting",
        pendingCandidates: [],
        polite: false,
      };
      this.#peers.set(key, peer);
    }

    // PC 未就绪 / 尚未 setRemoteDescription → 缓冲
    if (
      !peer.pc ||
      peer.pc.remoteDescription === null ||
      peer.pc.signalingState === "have-local-offer"
    ) {
      peer.pendingCandidates.push(signal.candidate);
      return;
    }

    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch (err) {
      console.warn("[RTCManager] addIceCandidate failed:", err);
    }
  }

  /**
   * 把 peer.pendingCandidates 中的候选依次 addIceCandidate。
   * setRemoteDescription 成功后立即调用；任意单条失败仅告警不中断。
   */
  async #flushPendingCandidates(peer) {
    if (!peer.pc || peer.pendingCandidates.length === 0) return;
    const candidates = peer.pendingCandidates;
    peer.pendingCandidates = [];
    for (const candidate of candidates) {
      try {
        await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn("[RTCManager] flush addIceCandidate failed:", err);
      }
    }
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
