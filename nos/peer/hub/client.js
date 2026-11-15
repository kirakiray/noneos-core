/**
 * SharedWorker Hub 客户端（Stage 2）
 *
 * 页面侧只持有 MessagePort；连接、PeerSession、加密都在 hub 内。
 */
import { toBytes } from "../bytes.js";
import { RtcLeader } from "../rtc/leader.js";

export class PeerHubClient {
  #worker;
  #port;
  #pending = new Map();
  #requestId = 1;
  #messageHandler = null;
  #closed = false;
  #userId = null;
  #leader = null;

  constructor({ url = "/nos/peer/hub/shared-worker.js", name = "noneos-peer" } = {}) {
    if (typeof SharedWorker === "undefined") {
      throw new Error("SharedWorker is not available");
    }
    this.#worker = new SharedWorker(url, { type: "module", name });
    this.#port = this.#worker.port;
    this.#port.onmessage = (event) => this.#handle(event.data);
    this.#port.start();
    globalThis.addEventListener?.("pagehide", () => {
      this.#port.postMessage({ type: "disconnect" });
    });
  }

  onMessage(handler) {
    this.#messageHandler = handler;
    return () => {
      if (this.#messageHandler === handler) this.#messageHandler = null;
    };
  }

  request(type, payload = {}) {
    if (this.#closed) return Promise.reject(new Error("hub client is closed"));
    const id = this.#requestId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#port.postMessage({ type, id, ...payload });
    });
  }

  get userId() {
    return this.#userId;
  }

  async connect({ url, identity } = {}) {
    if (identity && (!identity.publicKey || !identity.privateKey)) {
      throw new TypeError("identity must include publicKey and privateKey");
    }
    if (identity) this.#userId = identity.userId;
    const info = await this.request("connect", {
      url,
      identity: identity
        ? {
            userId: identity.userId,
            publicKey: identity.publicKey,
            privateKey: identity.privateKey,
          }
        : undefined,
    });
    if (info?.userId) this.#userId = info.userId;
    return this;
  }

  send(peerId, data, { reliable = true } = {}) {
    return this.request("send", { peerId, data: toBytes(data), reliable });
  }

  registerServices(appIds) {
    return this.request("services-register", { appIds });
  }

  async lookupService(appId) {
    const result = await this.request("services-lookup", { appId });
    return result?.userIds || result || [];
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#port.postMessage({ type: "disconnect" });
    this.#leader?.close();
    this.#leader = null;
    for (const { reject } of this.#pending.values()) {
      reject(new Error("hub client closed"));
    }
    this.#pending.clear();
    this.#port.close();
  }

  #handle(message) {
    if (!message || typeof message !== "object") return;

    if (message.type === "leader") {
      if (!this.#leader && this.#userId && typeof globalThis.RTCPeerConnection === "function") {
        this.#leader = new RtcLeader({
          localId: this.#userId,
          RTCPeerConnectionImpl: globalThis.RTCPeerConnection,
          send: (payload) => this.#port.postMessage(payload),
        });
      }
      return;
    }

    if (message.type === "rtc-open") {
      this.#leader?.open(message.peerId);
      return;
    }
    if (message.type === "rtc-close") {
      this.#leader?.closePeer(message.peerId);
      return;
    }
    if (message.type === "rtc-frame") {
      this.#leader?.sendFrame(message.peerId, toBytes(message.frame));
      return;
    }
    if (message.type === "rtc-signal") {
      this.#leader?.handleSignal(message.peerId, message.signal);
      return;
    }
    if (message.type === "rtc-enabled") {
      return;
    }

    if (message.type === "message") {
      this.#messageHandler?.(message.payload, {
        peerId: message.peerId,
        seq: message.seq,
      });
      return;
    }

    if (message.type === "connected") {
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        pending.resolve({ userId: message.userId, publicKey: message.publicKey });
      }
      return;
    }

    if (message.type === "response") {
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      }
      return;
    }

    if (message.type === "sent") {
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        pending.resolve(message.result);
      }
      return;
    }

    if (message.type === "send-error" || message.type === "connect-error") {
      const pending = this.#pending.get(message.id);
      if (pending) {
        this.#pending.delete(message.id);
        pending.reject(new Error(message.message));
      }
    }
  }
}
