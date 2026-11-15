/**
 * 发送端未确认消息队列（Stage 1 内存实现）
 *
 * 后续阶段可替换为基于 nos/storage 的持久化实现，接口保持不变：
 * add / get / delete / entries / clear / size
 */
export class Outbox {
  #map = new Map();

  add(entry) {
    if (!entry || !Number.isInteger(entry.seq)) {
      throw new TypeError("outbox entry requires an integer seq");
    }
    if (this.#map.has(entry.seq)) {
      throw new Error(`duplicate outbox seq: ${entry.seq}`);
    }
    this.#map.set(entry.seq, entry);
  }

  get(seq) {
    return this.#map.get(seq);
  }

  delete(seq) {
    return this.#map.delete(seq);
  }

  entries() {
    return [...this.#map.values()].sort((a, b) => a.seq - b.seq);
  }

  clear() {
    this.#map.clear();
  }

  get size() {
    return this.#map.size;
  }
}
