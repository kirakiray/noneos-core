/**
 * Relay 多路复用（Stage 2）
 *
 * 一个设备只维持一条 Relay 连接；每个远端 peer 的逻辑帧通过
 * from/to 路由复用同一条连接。
 *
 * 信封格式（大端）：
 *   u8  version (1)
 *   u8  type    (1=data)
 *   u16 fromLen
 *   ... from UTF-8
 *   u16 toLen
 *   ... to UTF-8
 *   ... 内层 PeerSession 帧
 */
import { toBytes } from "../bytes.js";

const MUX_VERSION = 1;
const MUX_TYPE_DATA = 1;

const writeId = (view, offset, id) => {
  const bytes = new TextEncoder().encode(id);
  if (bytes.byteLength > 0xffff) throw new RangeError("peer id too long");
  view.setUint16(offset, bytes.byteLength);
  new Uint8Array(view.buffer, offset + 2, bytes.byteLength).set(bytes);
  return offset + 2 + bytes.byteLength;
};

export const encodeMuxFrame = ({ from, to, frame }) => {
  if (typeof from !== "string" || typeof to !== "string" || !from || !to) {
    throw new TypeError("mux frame requires from/to strings");
  }
  const inner = toBytes(frame);
  const fromBytes = new TextEncoder().encode(from);
  const toBytesId = new TextEncoder().encode(to);
  if (fromBytes.byteLength > 0xffff || toBytesId.byteLength > 0xffff) {
    throw new RangeError("peer id too long");
  }

  const size = 4 + fromBytes.byteLength + 2 + toBytesId.byteLength + inner.byteLength;
  const buffer = new ArrayBuffer(size);
  const view = new DataView(buffer);
  view.setUint8(0, MUX_VERSION);
  view.setUint8(1, MUX_TYPE_DATA);
  let offset = 2;
  offset = writeId(view, offset, from);
  offset = writeId(view, offset, to);
  new Uint8Array(buffer).set(inner, offset);
  return new Uint8Array(buffer);
};

export const decodeMuxFrame = (input) => {
  const bytes = toBytes(input);
  if (bytes.byteLength < 4) throw new RangeError("mux frame too short");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint8(0) !== MUX_VERSION) throw new RangeError("unsupported mux version");
  if (view.getUint8(1) !== MUX_TYPE_DATA) throw new RangeError("unsupported mux type");

  let offset = 2;
  const fromLen = view.getUint16(offset);
  offset += 2;
  if (offset + fromLen > bytes.byteLength) throw new RangeError("truncated from id");
  const from = new TextDecoder().decode(bytes.subarray(offset, offset + fromLen));
  offset += fromLen;

  if (offset + 2 > bytes.byteLength) throw new RangeError("truncated to length");
  const toLen = view.getUint16(offset);
  offset += 2;
  if (offset + toLen > bytes.byteLength) throw new RangeError("truncated to id");
  const to = new TextDecoder().decode(bytes.subarray(offset, offset + toLen));
  offset += toLen;

  return { from, to, frame: bytes.slice(offset) };
};

class MuxLink {
  #mux;
  #remoteId;
  #frameHandler = null;
  #closeHandler = null;
  #state = "open";

  constructor(mux, remoteId) {
    this.#mux = mux;
    this.#remoteId = remoteId;
  }

  get remoteId() {
    return this.#remoteId;
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
    if (this.#state !== "open") throw new Error("mux link is closed");
    return this.#mux.send(this.#remoteId, frame);
  }

  close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#frameHandler = null;
    this.#closeHandler?.();
    this.#mux._removeLink(this.#remoteId);
  }

  _receive(frame) {
    if (this.#state === "open") this.#frameHandler?.(frame);
  }

  _close() {
    if (this.#state === "closed") return;
    this.#state = "closed";
    this.#closeHandler?.();
  }
}

export class RelayMux {
  #transport;
  #localId;
  #links = new Map();
  #linkHandlers = new Set();
  #unbindMessage;
  #unbindClose;
  #closed = false;

  constructor({ transport, localId }) {
    if (!transport) throw new TypeError("RelayMux requires a transport");
    if (!localId) throw new TypeError("RelayMux requires localId");
    this.#transport = transport;
    this.#localId = localId;
    this.#unbindMessage = transport.onMessage((data) => this.#handle(data));
    this.#unbindClose = transport.onClose?.(() => this.close("transport closed"));
  }

  get localId() {
    return this.#localId;
  }

  get closed() {
    return this.#closed;
  }

  onLink(handler) {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    this.#linkHandlers.add(handler);
    return () => this.#linkHandlers.delete(handler);
  }

  link(remoteId) {
    if (this.#closed) throw new Error("RelayMux is closed");
    let link = this.#links.get(remoteId);
    if (!link) {
      link = new MuxLink(this, remoteId);
      this.#links.set(remoteId, link);
      for (const handler of this.#linkHandlers) {
        try {
          handler(link);
        } catch (err) {
          console.error("[RelayMux] link handler failed:", err);
        }
      }
    }
    return link;
  }

  send(remoteId, frame) {
    if (this.#closed) return Promise.reject(new Error("RelayMux is closed"));
    return this.#transport.send(
      encodeMuxFrame({ from: this.#localId, to: remoteId, frame }),
    );
  }

  close(reason = "closed") {
    if (this.#closed) return;
    this.#closed = true;
    this.#unbindMessage?.();
    this.#unbindClose?.();
    for (const link of this.#links.values()) link._close();
    this.#links.clear();
    this.#linkHandlers.clear();
    try {
      this.#transport.close?.();
    } catch {
      // ignore
    }
  }

  _removeLink(remoteId) {
    this.#links.delete(remoteId);
  }

  #handle(data) {
    let decoded;
    try {
      decoded = decodeMuxFrame(data);
    } catch (err) {
      console.warn("[RelayMux] invalid frame:", err);
      return;
    }
    if (decoded.to !== this.#localId) {
      console.warn(`[RelayMux] frame for ${decoded.to}, expected ${this.#localId}`);
      return;
    }
    this.link(decoded.from)._receive(decoded.frame);
  }
}
