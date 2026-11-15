/**
 * PeerHub（Stage 2）
 *
 * 运行在 SharedWorker 中：持有 PeerSession、把消息广播到所有标签页。
 * 标签页只通过 MessagePort 发 RPC，不直接接触 Relay/PeerSession。
 *
 * 端口协议：
 *   tab -> hub: { type: "send", id, peerId, data, reliable }
 *   hub -> tab: { type: "sent", id, result } | { type: "send-error", id, message }
 *   hub -> tab: { type: "message", peerId, seq, payload }
 */
import { PeerSession } from "../session.js";
import { toBytes } from "../bytes.js";
import { RtcProxyLink } from "./rtc-proxy-link.js";
import { createCodec } from "../e2ee.js";
import { lookupService, registerServices } from "../services.js";

const APP = 0;
const CONTROL = 1;

export class PeerHub {
  #mux;
  #sessionOptions;
  #sessions = new Map();
  #ports = new Set();
  #leaderPort = null;
  #rtcLinks = new Map();
  #rtcRequested = new Set();
  #portMeta = new Map();
  #identity = null;
  #transport = null;
  #resolvePublicKey = null;
  #codecs = new Map();
  #unbindLink;
  #closed = false;

  constructor({ mux, transport = null, identity = null, resolvePublicKey = null, sessionOptions = {} } = {}) {
    if (!mux) throw new TypeError("PeerHub requires a mux");
    this.#mux = mux;
    this.#transport = transport;
    this.#identity = identity;
    this.#resolvePublicKey = resolvePublicKey;
    this.#sessionOptions = sessionOptions;
    this.#unbindLink = mux.onLink((link) => this.#ensureSession(link.remoteId, link));
  }

  get mux() {
    return this.#mux;
  }

  registerServices(appIds) {
    if (!this.#transport) throw new Error("PeerHub has no transport");
    return registerServices({ transport: this.#transport, appIds });
  }

  lookupService(appId) {
    if (!this.#transport) throw new Error("PeerHub has no transport");
    return lookupService({ transport: this.#transport, appId });
  }

  get sessionCount() {
    return this.#sessions.size;
  }

  registerPort(port) {
    if (!port || typeof port.postMessage !== "function") {
      throw new TypeError("registerPort requires a MessagePort-like object");
    }
    this.#ports.add(port);
    this.#portMeta.set(port, { tabId: `tab-${this.#ports.size}-${Date.now()}` });
    port.onmessage = (event) => this.#handlePortMessage(port, event.data);
    port.start?.();
    if (!this.#leaderPort) this.#setLeader(port);
    return () => this.unregisterPort(port);
  }

  unregisterPort(port) {
    if (!this.#ports.has(port)) return;
    this.#ports.delete(port);
    this.#portMeta.delete(port);
    port.onmessage = null;
    if (this.#leaderPort === port) {
      this.#leaderPort = null;
      for (const peerId of [...this.#rtcLinks.keys()]) this.#switchToRelay(peerId);
      const next = this.#ports.values().next().value ?? null;
      if (next) this.#setLeader(next);
    }
  }

  async send(peerId, data, { reliable = true } = {}) {
    if (this.#closed) throw new Error("PeerHub is closed");
    const session = this.#ensureSession(peerId);
    const payload = await this.#encode(peerId, this.#wrapApp(data));
    return session.send(payload, { reliable });
  }

  close(reason = "hub closed") {
    if (this.#closed) return;
    this.#closed = true;
    this.#unbindLink?.();
    for (const session of this.#sessions.values()) session.close(reason);
    this.#sessions.clear();
    for (const proxy of this.#rtcLinks.values()) proxy.close();
    this.#rtcLinks.clear();
    for (const port of this.#ports) port.close?.();
    this.#ports.clear();
    this.#portMeta.clear();
    this.#leaderPort = null;
    this.#mux.close(reason);
  }

  #ensureSession(peerId, link = this.#mux.link(peerId)) {
    let session = this.#sessions.get(peerId);
    if (session) return session;

    session = new PeerSession({
      link,
      ...this.#sessionOptions,
    });
    session.onMessage((payload, meta) => {
      this.#handleSessionMessage(peerId, payload, meta);
    });
    session.start();
    this.#sessions.set(peerId, session);
    this.#requestRtc(peerId);
    return session;
  }

  #wrapApp(data) {
    const payload = toBytes(data);
    const out = new Uint8Array(payload.byteLength + 1);
    out[0] = APP;
    out.set(payload, 1);
    return out;
  }

  async #sendControl(peerId, signal) {
    const session = this.#ensureSession(peerId);
    const json = new TextEncoder().encode(JSON.stringify(signal));
    const payload = new Uint8Array(json.byteLength + 1);
    payload[0] = CONTROL;
    payload.set(json, 1);
    return session.send(await this.#encode(peerId, payload));
  }

  async #getCodec(peerId) {
    if (!this.#identity || typeof this.#resolvePublicKey !== "function") return null;
    let codec = this.#codecs.get(peerId);
    if (!codec) {
      codec = Promise.resolve(this.#resolvePublicKey(peerId))
        .then((publicKey) => {
          if (!publicKey) throw new Error(`public key not found: ${peerId}`);
          return createCodec({ localIdentity: this.#identity, remotePublicKey: publicKey });
        })
        .catch((err) => {
          this.#codecs.delete(peerId);
          throw err;
        });
      this.#codecs.set(peerId, codec);
    }
    return codec;
  }

  async #encode(peerId, payload) {
    const codec = await this.#getCodec(peerId);
    return codec ? codec.encode(payload) : payload;
  }

  async #decode(peerId, payload) {
    const codec = await this.#getCodec(peerId);
    return codec ? codec.decode(payload) : payload;
  }

  #setLeader(port) {
    this.#leaderPort = port;
    port.postMessage({ type: "leader" });
    this.#rtcRequested.clear();
    for (const peerId of this.#sessions.keys()) this.#requestRtc(peerId);
  }

  #requestRtc(peerId) {
    if (!this.#leaderPort || this.#rtcLinks.has(peerId) || this.#rtcRequested.has(peerId)) return;
    this.#rtcRequested.add(peerId);
    this.#leaderPort.postMessage({ type: "rtc-open", peerId });
  }

  #switchToRtc(peerId) {
    if (!this.#leaderPort) return;
    const session = this.#sessions.get(peerId);
    if (!session) return;
    if (this.#rtcLinks.has(peerId)) return;
    const proxy = new RtcProxyLink({
      peerId,
      sendFrame: (frame) => {
        this.#leaderPort?.postMessage({ type: "rtc-frame", peerId, frame });
      },
      onClose: () => {
        this.#rtcLinks.delete(peerId);
      },
    });
    this.#rtcLinks.set(peerId, proxy);
    session.replaceLink(proxy);
    this.#leaderPort.postMessage({ type: "rtc-enabled", peerId });
  }

  #switchToRelay(peerId) {
    const proxy = this.#rtcLinks.get(peerId);
    if (!proxy) return;
    this.#rtcLinks.delete(peerId);
    const session = this.#sessions.get(peerId);
    if (session) session.replaceLink(this.#mux.link(peerId));
    this.#leaderPort?.postMessage({ type: "rtc-close", peerId });
  }

  async #handleSessionMessage(peerId, payload, meta) {
    let decoded;
    try {
      decoded = await this.#decode(peerId, payload);
    } catch (err) {
      console.warn("[PeerHub] decrypt failed:", err);
      return;
    }
    if (decoded[0] === CONTROL) {
      if (!this.#leaderPort) return;
      try {
        const signal = JSON.parse(new TextDecoder().decode(decoded.subarray(1)));
        this.#leaderPort.postMessage({ type: "rtc-signal", peerId, signal });
      } catch (err) {
        console.warn("[PeerHub] invalid control message:", err);
      }
      return;
    }
    this.#broadcast({
      type: "message",
      peerId,
      seq: meta.seq,
      payload: decoded.subarray(1),
    });
  }

  #broadcast(message) {
    for (const port of this.#ports) {
      try {
        port.postMessage(message);
      } catch (err) {
        console.error("[PeerHub] postMessage failed:", err);
      }
    }
  }

  #handlePortMessage(port, message) {
    if (!message || typeof message !== "object") return;
    if (message.type === "disconnect") {
      this.unregisterPort(port);
      return;
    }
    if (message.type === "rtc-signal") {
      this.#sendControl(message.peerId, message.signal).catch((err) => {
        console.warn("[PeerHub] send signal failed:", err);
      });
      return;
    }
    if (message.type === "rtc-frame") {
      this.#rtcLinks.get(message.peerId)?.receive(toBytes(message.frame));
      return;
    }
    if (message.type === "rtc-state") {
      if (message.state === "connected") this.#switchToRtc(message.peerId);
      else this.#switchToRelay(message.peerId);
      return;
    }
    if (message.type === "services-register") {
      this.registerServices(message.appIds)
        .then((result) => port.postMessage({ type: "response", id: message.id, result }))
        .catch((err) =>
          port.postMessage({
            type: "response",
            id: message.id,
            error: err?.message || String(err),
          }),
        );
      return;
    }

    if (message.type === "services-lookup") {
      this.lookupService(message.appId)
        .then((result) => port.postMessage({ type: "response", id: message.id, result }))
        .catch((err) =>
          port.postMessage({
            type: "response",
            id: message.id,
            error: err?.message || String(err),
          }),
        );
      return;
    }

    if (message.type === "send") {
      this.send(message.peerId, message.data, {
        reliable: message.reliable !== false,
      })
        .then((result) => {
          port.postMessage({ type: "sent", id: message.id, result });
        })
        .catch((err) => {
          port.postMessage({
            type: "send-error",
            id: message.id,
            message: err?.message || String(err),
          });
        });
    }
  }
}
