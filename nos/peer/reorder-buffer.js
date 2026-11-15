/**
 * 接收端重排/去重（Stage 1）
 *
 * - 单调 receivedThrough：已连续交付的最大 seq
 * - 小窗口缓存乱序帧；重复帧直接丢弃
 * - 窗口外的帧不再缓存，靠发送端重传
 */
export class ReorderBuffer {
  #windowSize;
  #receivedThrough = 0;
  #pending = new Map();

  constructor({ windowSize = 256 } = {}) {
    if (!Number.isInteger(windowSize) || windowSize < 1) {
      throw new RangeError("windowSize must be a positive integer");
    }
    this.#windowSize = windowSize;
  }

  get receivedThrough() {
    return this.#receivedThrough;
  }

  get pendingCount() {
    return this.#pending.size;
  }

  /**
   * @param {number} seq
   * @param {Uint8Array} payload
   * @returns {{status: "duplicate"|"buffered"|"out-of-window"|"deliver", messages: Array<{seq:number,payload:Uint8Array}>}}
   */
  accept(seq, payload) {
    if (!Number.isInteger(seq) || seq < 1) {
      throw new RangeError(`seq must be a positive integer, got ${seq}`);
    }

    if (seq <= this.#receivedThrough) {
      return { status: "duplicate", messages: [] };
    }

    if (seq > this.#receivedThrough + this.#windowSize) {
      return { status: "out-of-window", messages: [] };
    }

    if (this.#pending.has(seq)) {
      return { status: "duplicate", messages: [] };
    }

    this.#pending.set(seq, payload);

    if (seq !== this.#receivedThrough + 1) {
      return { status: "buffered", messages: [] };
    }

    const messages = [];
    while (this.#pending.has(this.#receivedThrough + 1)) {
      const next = this.#receivedThrough + 1;
      messages.push({ seq: next, payload: this.#pending.get(next) });
      this.#pending.delete(next);
      this.#receivedThrough = next;
    }
    return { status: "deliver", messages };
  }

  reset() {
    this.#receivedThrough = 0;
    this.#pending.clear();
  }
}
