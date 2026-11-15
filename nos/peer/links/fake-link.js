/**
 * 内存 FakeLink：用于单元测试 PeerSession，不依赖浏览器网络。
 *
 * 支持：
 * - 双端配对（createFakeLinkPair）
 * - dropNext / duplicateNext 模拟丢包与重复
 * - onFrame / onClose
 */
export class FakeLink {
  #peer = null;
  #frameHandler = null;
  #closeHandler = null;
  #state = "open";

  constructor({ name = "fake" } = {}) {
    this.name = name;
    this.dropNext = 0;
    this.duplicateNext = 0;
  }

  get state() {
    return this.#state;
  }

  attachPeer(peer) {
    this.#peer = peer;
  }

  onFrame(handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    this.#frameHandler = handler;
    return () => {
      if (this.#frameHandler === handler) this.#frameHandler = null;
    };
  }

  onClose(handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    this.#closeHandler = handler;
    return () => {
      if (this.#closeHandler === handler) this.#closeHandler = null;
    };
  }

  async send(frame) {
    if (this.#state !== "open") throw new Error("link is closed");
    if (!this.#peer || this.#peer.state !== "open") return;

    if (this.dropNext > 0) {
      this.dropNext -= 1;
      return;
    }

    const copy = frame.slice();
    this.#peer.#receive(copy);

    if (this.duplicateNext > 0) {
      this.duplicateNext -= 1;
      this.#peer.#receive(copy.slice());
    }
  }

  close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#frameHandler = null;
    if (this.#closeHandler) this.#closeHandler();
    this.#peer?.close();
  }

  #receive(frame) {
    if (this.#state !== "open") return;
    this.#frameHandler?.(frame);
  }
}

export const createFakeLinkPair = ({ names = ["a", "b"] } = {}) => {
  const a = new FakeLink({ name: names[0] });
  const b = new FakeLink({ name: names[1] });
  a.attachPeer(b);
  b.attachPeer(a);
  return [a, b];
};
