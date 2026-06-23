/**
 * RTCManager - 管理本地用户与其他用户 session 之间的 WebRTC 直连。
 *
 * 设计原则：
 * - 服务端不做任何改动，RTC 信令（SDP/ICE）通过现有的服务器 relay 中转。
 * - 每条 RTC 连接以 "userId:sessionId" 为 key，由当前标签页独立维护。
 * - 连接在首次需要时（RemoteUser.send）后台发起，不阻塞消息发送。
 * - 任何环节失败都静默放弃，业务层继续走服务器中转兜底。
 */

export class RTCManager {
  #user;
  #peers = new Map(); // key: "userId:sessionId" -> { pc, dc, state }
  #connectPromises = new Map(); // key -> Promise，防止并发重复建连

  /**
   * @param {import("./user.js").LocalUser} user - 本地用户实例
   */
  constructor(user) {
    this.#user = user;
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

    const pc = new RTCPeerConnection({ iceServers: [] });
    const dc = pc.createDataChannel("noneos", { ordered: true });

    this.#setupDataChannel(dc, userId, sessionId);
    this.#setupPeerConnection(pc, userId, sessionId);

    this.#peers.set(key, { pc, dc, state: "connecting" });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    await this.#sendSignal(userId, sessionId, { type: "offer", sdp: offer.sdp });
  }

  async #handleOffer(key, userId, sessionId, signal) {
    const pc = new RTCPeerConnection({ iceServers: [] });
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
