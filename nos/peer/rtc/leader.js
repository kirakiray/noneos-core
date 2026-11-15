/**
 * leader 标签页内的 RTC 运行时（Stage 4）
 *
 * - 每个 peer 一个 RTCPeerConnection
 * - 单条 reliable ordered DataChannel 承载 PeerSession 帧
 * - 信令通过 hub 的控制通道（PeerSession control prefix）转发
 * - 不配置 TURN：默认只用 STUN；直连失败由 hub 留在 WS
 */
export class RtcLeader {
  #localId;
  #send;
  #RTCPeerConnectionImpl;
  #rtcConfig;
  #peers = new Map();
  #closed = false;

  constructor({
    localId,
    send,
    RTCPeerConnectionImpl = globalThis.RTCPeerConnection,
    rtcConfig = { iceServers: [] },
  }) {
    if (!localId) throw new TypeError("RtcLeader requires localId");
    if (typeof send !== "function") throw new TypeError("RtcLeader requires send()");
    this.#localId = localId;
    this.#send = send;
    this.#RTCPeerConnectionImpl = RTCPeerConnectionImpl;
    this.#rtcConfig = rtcConfig;
  }

  get supported() {
    return typeof this.#RTCPeerConnectionImpl === "function";
  }

  open(peerId) {
    if (this.#closed || !this.supported) return null;
    return this.#ensurePeer(peerId);
  }

  handleSignal(peerId, signal) {
    if (this.#closed || !this.supported) return;
    const peer = this.#ensurePeer(peerId);
    this.#handleSignal(peerId, peer, signal);
  }

  sendFrame(peerId, frame) {
    const peer = this.#peers.get(peerId);
    if (!peer?.channel || peer.channel.readyState !== "open") {
      throw new Error(`RTC channel is not open for ${peerId}`);
    }
    peer.channel.send(frame);
  }

  closePeer(peerId) {
    const peer = this.#peers.get(peerId);
    if (!peer) return;
    this.#peers.delete(peerId);
    try {
      peer.channel?.close();
    } catch {}
    try {
      peer.pc.close();
    } catch {}
    this.#send({ type: "rtc-state", peerId, state: "closed" });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    for (const peerId of [...this.#peers.keys()]) this.closePeer(peerId);
  }

  #ensurePeer(peerId) {
    let peer = this.#peers.get(peerId);
    if (peer) return peer;

    const pc = new this.#RTCPeerConnectionImpl(this.#rtcConfig);
    peer = {
      pc,
      channel: null,
      initiator: this.#localId < peerId,
      pendingCandidates: [],
      remoteSet: false,
      connectedSent: false,
    };
    this.#peers.set(peerId, peer);

    pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.#send({
          type: "rtc-signal",
          peerId,
          signal: { kind: "ice", candidate: event.candidate.toJSON?.() ?? event.candidate },
        });
      }
    };

    pc.onconnectionstatechange = () => {
      if (["failed", "closed", "disconnected"].includes(pc.connectionState)) {
        this.#send({ type: "rtc-state", peerId, state: "closed" });
      }
    };

    if (peer.initiator) {
      this.#attachChannel(peerId, peer, pc.createDataChannel("peer", { ordered: true }));
      this.#createOffer(peerId, peer);
    }

    pc.ondatachannel = (event) => {
      this.#attachChannel(peerId, peer, event.channel);
    };

    return peer;
  }

  #attachChannel(peerId, peer, channel) {
    if (peer.channel) return;
    peer.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (!peer.connectedSent) {
        peer.connectedSent = true;
        this.#send({ type: "rtc-state", peerId, state: "connected" });
      }
    };
    channel.onclose = () => {
      this.#send({ type: "rtc-state", peerId, state: "closed" });
    };
    channel.onmessage = (event) => {
      const data = event.data;
      if (data instanceof ArrayBuffer) {
        this.#send({ type: "rtc-frame", peerId, frame: new Uint8Array(data) });
      } else if (data instanceof Uint8Array) {
        this.#send({ type: "rtc-frame", peerId, frame: data });
      }
    };
  }

  async #createOffer(peerId, peer) {
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription(offer);
      this.#send({
        type: "rtc-signal",
        peerId,
        signal: { kind: "offer", sdp: peer.pc.localDescription },
      });
    } catch (err) {
      console.warn("[RtcLeader] createOffer failed:", err);
      this.#send({ type: "rtc-state", peerId, state: "closed" });
    }
  }

  async #handleSignal(peerId, peer, signal) {
    if (!signal || typeof signal !== "object") return;
    try {
      if (signal.kind === "offer") {
        await peer.pc.setRemoteDescription(signal.sdp);
        peer.remoteSet = true;
        await this.#flushCandidates(peer);
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription(answer);
        this.#send({
          type: "rtc-signal",
          peerId,
          signal: { kind: "answer", sdp: peer.pc.localDescription },
        });
      } else if (signal.kind === "answer") {
        await peer.pc.setRemoteDescription(signal.sdp);
        peer.remoteSet = true;
        await this.#flushCandidates(peer);
      } else if (signal.kind === "ice") {
        if (!peer.remoteSet) {
          peer.pendingCandidates.push(signal.candidate);
        } else {
          await peer.pc.addIceCandidate(signal.candidate);
        }
      }
    } catch (err) {
      console.warn("[RtcLeader] signal handling failed:", err);
    }
  }

  async #flushCandidates(peer) {
    for (const candidate of peer.pendingCandidates.splice(0)) {
      await peer.pc.addIceCandidate(candidate);
    }
  }
}
