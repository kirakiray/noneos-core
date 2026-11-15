/**
 * 运行在 SharedWorker 中的 RTC 代理链路（Stage 4）
 *
 * 真实 RTCPeerConnection 在 leader 标签页；本对象只把帧通过
 * MessagePort 转发给 leader，并把 leader 收到的帧交回 PeerSession。
 */
export class RtcProxyLink {
  #peerId;
  #sendFrame;
  #onClose;
  #frameHandler = null;
  #closeHandler = null;
  #state = "open";

  constructor({ peerId, sendFrame, onClose }) {
    this.#peerId = peerId;
    this.#sendFrame = sendFrame;
    this.#onClose = onClose;
  }

  get peerId() {
    return this.#peerId;
  }

  get state() {
    return this.#state;
  }

  onFrame(handler) {
    this.#frameHandler = handler;
    return () => {
      if (this.#frameHandler === handler) this.#frameHandler = null;
    };
  }

  onClose(handler) {
    this.#closeHandler = handler;
    return () => {
      if (this.#closeHandler === handler) this.#closeHandler = null;
    };
  }

  send(frame) {
    if (this.#state !== "open") throw new Error("rtc proxy link is closed");
    this.#sendFrame(frame);
    return Promise.resolve();
  }

  close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#frameHandler = null;
    this.#closeHandler?.();
    this.#onClose?.();
  }

  receive(frame) {
    if (this.#state === "open") this.#frameHandler?.(frame);
  }
}
