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
  // key -> Promise chain，串行化对同一 PC 的操作（#doConnect / #handleOffer）
  // 避免 createOffer 期间到达的 offer 与 #doConnect 并发操作 PC 导致状态混乱
  #pcLocks = new Map();

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
    if (existing?.state === "connected") {
      console.log(
        `[RTCManager] connect() skipped: already connected, key=${key}`,
      );
      return;
    }
    if (existing?.dc?.readyState === "open") {
      console.log(
        `[RTCManager] connect() skipped: dc already open, key=${key}`,
      );
      return;
    }
    // 已有 PC 且正处于协商中（have-local-offer / have-remote-offer）→ 不打断
    if (
      existing?.pc &&
      existing.pc.signalingState !== "stable" &&
      existing.pc.signalingState !== "closed"
    ) {
      console.log(
        `[RTCManager] connect() skipped: negotiating (signalingState=${existing.pc.signalingState}), key=${key}`,
      );
      return;
    }

    if (this.#connectPromises.has(key)) {
      console.log(
        `[RTCManager] connect() reused: in-flight promise, key=${key}`,
      );
      return this.#connectPromises.get(key);
    }

    console.log(
      `[RTCManager] connect() initiating new connection, key=${key}, polite=${this.#isPolite(userId)}`,
    );
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
    console.log(
      `[RTCManager] handleSignal recv: from=${fromUserId}:${fromSessionId}, type=${signal.type}, key=${key}`,
    );

    try {
      if (signal.type === "offer") {
        await this.#handleOffer(key, fromUserId, fromSessionId, signal);
      } else if (signal.type === "answer") {
        await this.#handleAnswer(key, signal);
      } else if (signal.type === "ice") {
        await this.#handleIce(key, signal);
      }
    } catch (err) {
      console.warn(
        `[RTCManager] handleSignal failed: key=${key}, type=${signal.type}`,
        err,
      );
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

    await this.#withPcLock(key, async () => {
      // 获取锁后再次检查：等待期间 #handleOffer 可能已建立 RTC 或正在协商
      const existing = this.#peers.get(key);
      if (existing?.dc?.readyState === "open") {
        console.log(
          `[RTCManager] #doConnect aborted: dc already open, key=${key}`,
        );
        return;
      }
      if (
        existing?.pc &&
        existing.pc.remoteDescription !== null &&
        existing.pc.connectionState !== "closed"
      ) {
        // PC 已被 #handleOffer 接管并完成 setRemoteDescription（作为 answer 方），
        // #doConnect 不再发 offer 避免覆盖已建立的协商
        console.log(
          `[RTCManager] #doConnect aborted: PC already in use (connectionState=${existing.pc.connectionState}, hasRemoteDesc=true), key=${key}`,
        );
        return;
      }

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
      console.log(
        `[RTCManager] #doConnect peer created, key=${key}, pendingCandidates=${previous?.pendingCandidates?.length ?? 0}`,
      );

      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      console.log(
        `[RTCManager] #doConnect local offer set, signalingState=${pc.signalingState}, key=${key}`,
      );

      await this.#sendSignal(userId, sessionId, {
        type: "offer",
        sdp: offer.sdp,
      });
      console.log(`[RTCManager] #doConnect offer signal sent, key=${key}`);
    });
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

    await this.#withPcLock(key, async () => {
      let peer = this.#peers.get(key);

      // 已通过 DataChannel 直连成功，忽略重复 offer
      if (peer?.dc?.readyState === "open") {
        console.log(
          `[RTCManager] #handleOffer skipped: dc already open, key=${key}`,
        );
        return;
      }

      // Glare：本地已发出 offer（have-local-offer）
      // 由于 #withPcLock 串行化，此时 #doConnect 的 setLocalDescription 已完成，
      // signalingState 要么是 have-local-offer（#doConnect 成功）要么是 stable
      if (peer?.pc && peer.pc.signalingState === "have-local-offer") {
        if (!polite) {
          // impolite 方坚持自己的 offer，忽略对方
          console.log(
            `[RTCManager] #handleOffer glare: impolite, ignore incoming offer, key=${key}`,
          );
          return;
        }
        // polite 方回退自己的 offer，沿用同一 PC 后续 setRemoteDescription(对方 offer)
        console.log(
          `[RTCManager] #handleOffer glare: polite, rollback local offer, key=${key}`,
        );
        try {
          await peer.pc.setLocalDescription({ type: "rollback" });
          peer.dc = null; // 旧 DC 属于已回滚的 offer，置空等对端 ondatachannel
        } catch (err) {
          console.warn(
            `[RTCManager] rollback local offer failed: key=${key}`,
            err,
          );
          return;
        }
      } else if (!peer?.pc || peer.pc.connectionState === "closed") {
        // 无可用 PC：新建并写入 #peers（提前写入，确保并发 ICE 能查到）
        console.log(
          `[RTCManager] #handleOffer creating new PC: key=${key}, polite=${polite}, oldPcState=${peer?.pc?.connectionState ?? "null"}`,
        );
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
        console.log(
          `[RTCManager] #handleOffer setRemoteDescription(offer) ok, signalingState=${peer.pc.signalingState}, key=${key}`,
        );
        // flush 在 remoteDescription 为 null 期间缓冲的 ICE 候选
        await this.#flushPendingCandidates(peer);

        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);

        await this.#sendSignal(userId, sessionId, {
          type: "answer",
          sdp: answer.sdp,
        });
        console.log(`[RTCManager] #handleOffer answer sent, key=${key}`);
      } catch (err) {
        console.warn(
          `[RTCManager] handleOffer processing failed: key=${key}`,
          err,
        );
      }
    });
  }

  async #handleAnswer(key, signal) {
    await this.#withPcLock(key, async () => {
      const peer = this.#peers.get(key);
      if (!peer?.pc) {
        console.log(
          `[RTCManager] #handleAnswer skipped: no peer/pc, key=${key}`,
        );
        return;
      }

      // 仅在 have-local-offer 时接受 answer；stable/have-remote-offer 收到 answer 是
      // 乱序或 glare 残留，忽略即可，不抛错以免触发外层 catch 的错误处理。
      if (peer.pc.signalingState !== "have-local-offer") {
        console.log(
          `[RTCManager] #handleAnswer skipped: signalingState=${peer.pc.signalingState} (not have-local-offer), key=${key}`,
        );
        return;
      }

      try {
        await peer.pc.setRemoteDescription(
          new RTCSessionDescription({ type: "answer", sdp: signal.sdp }),
        );
        console.log(
          `[RTCManager] #handleAnswer setRemoteDescription(answer) ok, signalingState=${peer.pc.signalingState}, key=${key}`,
        );
        await this.#flushPendingCandidates(peer);
      } catch (err) {
        console.warn(`[RTCManager] handleAnswer failed: key=${key}`, err);
      }
    });
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
      console.log(
        `[RTCManager] #handleIce: peer not exist, creating placeholder, key=${key}`,
      );
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
      console.log(
        `[RTCManager] #handleIce buffered (pending=${peer.pendingCandidates.length}): pcState=${peer.pc?.connectionState ?? "null"}, signalingState=${peer.pc?.signalingState ?? "null"}, key=${key}`,
      );
      return;
    }

    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      console.log(
        `[RTCManager] #handleIce addIceCandidate ok, key=${key}`,
      );
    } catch (err) {
      console.warn(`[RTCManager] addIceCandidate failed: key=${key}`, err);
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
      console.log(
        `[RTCManager] onconnectionstatechange: key=${key}, pcState=${pc.connectionState}, peerState=${peer?.state ?? "null"}`,
      );
      if (!peer) return;

      if (pc.connectionState === "connected") {
        peer.state = "connected";
      } else if (
        ["failed", "disconnected", "closed"].includes(pc.connectionState)
      ) {
        // PC 层先于 DataChannel 感知断开（如对端刷新导致 ICE 失败），
        // 这里主动 close 并上报 disconnected，让上层清理状态并允许重连。
        this.#teardownPeer(
          key,
          userId,
          sessionId,
          peer,
          pc,
          `pc:${pc.connectionState}`,
        );
      }
    };
  }

  #setupDataChannel(dc, userId, sessionId) {
    const key = this.#key(userId, sessionId);

    dc.onopen = () => {
      const peer = this.#peers.get(key);
      if (peer) peer.state = "connected";
      console.log(
        `[RTCManager] dc.onopen: key=${key}, peerState=${peer?.state ?? "null"}`,
      );
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
      const peer = this.#peers.get(key);
      console.log(
        `[RTCManager] dc.onclose: key=${key}, peerState=${peer?.state ?? "null"}`,
      );
      // peer 已被 #teardownPeer 处理过（PC 断开先触发）→ 跳过，避免重复事件
      if (!peer || peer.state === "disconnected") return;
      this.#teardownPeer(key, userId, sessionId, peer, peer.pc, "dc:close");
    };

    dc.onerror = (e) => {
      const peer = this.#peers.get(key);
      console.log(
        `[RTCManager] dc.onerror: key=${key}, peerState=${peer?.state ?? "null"}, error=${e?.message ?? e}`,
      );
      if (!peer || peer.state === "disconnected") return;
      this.#teardownPeer(key, userId, sessionId, peer, peer.pc, "dc:error");
    };
  }

  /**
   * 统一清理断开的 peer：幂等（同一 peer 只触发一次 disconnected 事件）。
   * - 关闭 PC 释放 ICE agent / 事件回调等资源
   * - 从 #peers 删除引用
   * - 上报 rtc_state(disconnected)，驱动上层 RemoteUser 清理重连标记
   *
   * @param {string} reason - 触发清理的来源，用于排查（如 "pc:failed"、"dc:close"）
   */
  #teardownPeer(key, userId, sessionId, peer, pc, reason) {
    if (peer.state === "disconnected") {
      console.log(
        `[RTCManager] #teardownPeer skipped (already disconnected): key=${key}, reason=${reason}`,
      );
      return;
    }
    console.log(
      `[RTCManager] #teardownPeer start: key=${key}, reason=${reason}, pcState=${pc?.connectionState ?? "null"}`,
    );
    peer.state = "disconnected";
    try {
      pc?.close();
    } catch (err) {
      console.warn(
        `[RTCManager] #teardownPeer pc.close() failed: key=${key}`,
        err,
      );
    }
    this.#peers.delete(key);
    this.#user._trigger("rtc_state", {
      userId,
      sessionId,
      state: "disconnected",
    });
    console.log(
      `[RTCManager] #teardownPeer done, triggered rtc_state(disconnected): key=${key}, reason=${reason}`,
    );
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

  /**
   * 串行化对同一 key PC 的操作。
   * #doConnect 的 createOffer/setLocalDescription 与 #handleOffer 的
   * setRemoteDescription 不能并发（会导致 signalingState 混乱），
   * 用 promise chain 保证同一 key 的 PC 操作按调用顺序依次执行。
   */
  async #withPcLock(key, fn) {
    const prev = this.#pcLocks.get(key) || Promise.resolve();
    let resolveNext;
    const next = new Promise((r) => {
      resolveNext = r;
    });
    this.#pcLocks.set(key, next);
    try {
      await prev;
      return await fn();
    } finally {
      resolveNext();
      if (this.#pcLocks.get(key) === next) {
        this.#pcLocks.delete(key);
      }
    }
  }
}
