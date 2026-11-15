/**
 * PeerSession（Stage 1）
 *
 * 一个 PeerSession 对应一个远端用户，负责：
 * - 单调 seq 与累积 ACK
 * - 超时重传（可靠消息）
 * - 接收端重排与去重
 * - 通过可替换的 Link 发送/接收二进制帧
 *
 * Link 契约（由 links/* 实现）：
 *   onFrame(handler) -> unsubscribe
 *   onClose(handler) -> unsubscribe（可选）
 *   send(Uint8Array) -> Promise<void>
 *   close() -> void
 *   state -> "open" | "closed"
 */
import {
  FrameFlags,
  FrameType,
  decodeFrame,
  encodeFrame,
} from "./framing.js";
import { Outbox } from "./outbox.js";
import { ReorderBuffer } from "./reorder-buffer.js";
import { toBytes } from "./bytes.js";

const defaultTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
  now: () => Date.now(),
};


export class PeerSession {
  #link;
  #timers;
  #ackTimeout;
  #maxRetries;
  #reorder;
  #outbox = new Outbox();
  #handlers = new Set();
  #unbindFrame = null;
  #unbindClose = null;
  #nextSeq = 1;
  #state = "new";
  #closedReason = null;
  #onError;

  constructor({
    link,
    ackTimeout = 800,
    maxRetries = 5,
    windowSize = 256,
    timers = defaultTimers,
    onError,
  } = {}) {
    if (!link) throw new TypeError("PeerSession requires a link");
    if (!Number.isFinite(ackTimeout) || ackTimeout <= 0) {
      throw new RangeError("ackTimeout must be a positive number");
    }
    if (!Number.isInteger(maxRetries) || maxRetries < 0) {
      throw new RangeError("maxRetries must be a non-negative integer");
    }

    this.#link = link;
    this.#timers = { ...defaultTimers, ...timers };
    this.#ackTimeout = ackTimeout;
    this.#maxRetries = maxRetries;
    this.#reorder = new ReorderBuffer({ windowSize });
    this.#onError = onError || ((err) => console.error("[PeerSession]", err));
  }

  get state() {
    return this.#state;
  }

  get receivedThrough() {
    return this.#reorder.receivedThrough;
  }

  get pendingCount() {
    return this.#outbox.size;
  }

  get link() {
    return this.#link;
  }

  start() {
    if (this.#state === "open") return this;
    if (this.#state === "closed") throw new Error("PeerSession is closed");
    this.#state = "open";
    this.#unbindFrame = this.#link.onFrame((frame) => this.#handleFrame(frame));
    if (typeof this.#link.onClose === "function") {
      this.#unbindClose = this.#link.onClose(() => this.close("link closed"));
    }
    return this;
  }

  onMessage(handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  /**
   * 发送一条消息
   * @param {Uint8Array|ArrayBuffer|ArrayBufferView|string} data
   * @param {{ reliable?: boolean }} [options]
   * @returns {Promise<{ seq: number, acked: boolean, attempts: number }>}
   */
  async send(data, { reliable = true } = {}) {
    if (this.#state !== "open") {
      throw new Error(`cannot send in state "${this.#state}"`);
    }
    const payload = toBytes(data);
    if (this.#nextSeq > 0xffffffff) throw new Error("sequence exhausted");
    const seq = this.#nextSeq++;

    if (!reliable) {
      await this.#link.send(
        encodeFrame({
          type: FrameType.DATA,
          flags: 0,
          seq,
          ack: this.#reorder.receivedThrough,
          payload,
        }),
      );
      return { seq, acked: false, attempts: 1 };
    }

    const entry = {
      seq,
      payload,
      attempts: 0,
      timer: null,
      settled: false,
      resolve: null,
      reject: null,
    };
    const promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    this.#outbox.add(entry);
    try {
      this.#transmit(entry);
    } catch (err) {
      if (entry.timer) this.#timers.clearTimeout(entry.timer);
      entry.timer = null;
      entry.settled = true;
      this.#outbox.delete(entry.seq);
      entry.reject(err);
    }
    return promise;
  }

  replaceLink(link) {
    if (!link) throw new TypeError("replaceLink requires a link");
    if (this.#state !== "open") throw new Error("PeerSession is not open");
    if (this.#unbindFrame) this.#unbindFrame();
    if (this.#unbindClose) this.#unbindClose();
    this.#link = link;
    this.#unbindFrame = link.onFrame((frame) => this.#handleFrame(frame));
    if (typeof link.onClose === "function") {
      this.#unbindClose = link.onClose(() => this.close("link closed"));
    }
    // 换链路后立即重发所有未确认消息（同一 seq，接收端去重）
    for (const entry of this.#outbox.entries()) {
      if (entry.timer) this.#timers.clearTimeout(entry.timer);
      entry.timer = null;
      entry.attempts = 0;
      this.#transmit(entry);
    }
  }

  close(reason = "closed") {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#closedReason = reason;

    if (this.#unbindFrame) this.#unbindFrame();
    if (this.#unbindClose) this.#unbindClose();

    for (const entry of this.#outbox.entries()) {
      if (entry.timer) this.#timers.clearTimeout(entry.timer);
      entry.timer = null;
      if (!entry.settled) {
        entry.settled = true;
        entry.reject(new Error(reason));
      }
    }
    this.#outbox.clear();

    try {
      this.#link.close?.();
    } catch {
      // 忽略 Link 关闭异常
    }
  }

  #transmit(entry) {
    if (entry.settled || this.#state !== "open") return;
    entry.attempts += 1;

    if (entry.timer) this.#timers.clearTimeout(entry.timer);
    entry.timer = this.#timers.setTimeout(() => {
      entry.timer = null;
      this.#handleTimeout(entry);
    }, this.#ackTimeout);

    const frame = encodeFrame({
      type: FrameType.DATA,
      flags: FrameFlags.RELIABLE,
      seq: entry.seq,
      ack: this.#reorder.receivedThrough,
      payload: entry.payload,
    });

    Promise.resolve()
      .then(() => this.#link.send(frame))
      .catch((err) => {
        this.#onError(err);
      });
  }

  #handleTimeout(entry) {
    if (entry.settled || this.#outbox.get(entry.seq) !== entry) return;
    if (entry.attempts >= this.#maxRetries + 1) {
      entry.settled = true;
      this.#outbox.delete(entry.seq);
      entry.reject(new Error(`ack timeout after ${entry.attempts} attempt(s)`));
      return;
    }
    this.#transmit(entry);
  }

  #handleAck(ack) {
    for (const entry of this.#outbox.entries()) {
      if (entry.seq > ack) break;
      if (entry.timer) this.#timers.clearTimeout(entry.timer);
      entry.timer = null;
      this.#outbox.delete(entry.seq);
      if (!entry.settled) {
        entry.settled = true;
        entry.resolve({ seq: entry.seq, acked: true, attempts: entry.attempts });
      }
    }
  }

  #handleFrame(frame) {
    let decoded;
    try {
      decoded = decodeFrame(frame);
    } catch (err) {
      this.#onError(err);
      return;
    }

    if (decoded.type === FrameType.ACK) {
      this.#handleAck(decoded.ack);
      return;
    }

    if (decoded.type === FrameType.PING) {
      this.#sendAck();
      return;
    }

    if (decoded.type !== FrameType.DATA) {
      return;
    }

    const result = this.#reorder.accept(decoded.seq, decoded.payload);
    if (result.status === "out-of-window") {
      this.#sendAck();
      return;
    }

    for (const message of result.messages) {
      for (const handler of this.#handlers) {
        try {
          handler(message.payload, { seq: message.seq });
        } catch (err) {
          this.#onError(err);
        }
      }
    }

    this.#sendAck();
  }

  #sendAck() {
    if (this.#state !== "open") return;
    const frame = encodeFrame({
      type: FrameType.ACK,
      ack: this.#reorder.receivedThrough,
    });
    Promise.resolve(this.#link.send(frame)).catch((err) => this.#onError(err));
  }
}
