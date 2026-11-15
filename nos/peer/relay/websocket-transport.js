/**
 * WebSocket RelayTransport（Stage 2）
 *
 * 只负责一条到 relay 服务的二进制长连接；多 peer 复用由 RelayMux 完成。
 * 后续 WebTransportTransport 实现同一接口即可替换。
 */
export class WebSocketTransport {
  #WebSocketImpl;
  #url;
  #socket = null;
  #state = "idle";
  #messageHandler = null;
  #textHandlers = new Set();
  #textBuffer = [];
  #closeHandler = null;
  #connectPromise = null;

  constructor(url, { WebSocketImpl = globalThis.WebSocket, connectTimeout = 10000 } = {}) {
    if (!url) throw new TypeError("WebSocketTransport requires a url");
    if (!WebSocketImpl) throw new Error("WebSocket is not available");
    this.#url = url;
    this.#WebSocketImpl = WebSocketImpl;
    this.connectTimeout = connectTimeout;
  }

  get state() {
    return this.#state;
  }

  connect() {
    if (this.#state === "open") return Promise.resolve(this);
    if (this.#connectPromise) return this.#connectPromise;

    this.#state = "connecting";
    this.#connectPromise = new Promise((resolve, reject) => {
      let settled = false;
      const socket = new this.#WebSocketImpl(this.#url);
      socket.binaryType = "arraybuffer";
      this.#socket = socket;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#state = "closed";
        try {
          socket.close();
        } catch {
          // ignore
        }
        reject(new Error("websocket connect timeout"));
      }, this.connectTimeout);

      socket.onopen = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#state = "open";
        resolve(this);
      };

      socket.onerror = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.#state = "closed";
        reject(new Error("websocket connection error"));
      };

      socket.onmessage = (event) => {
        this.#handleMessage(event.data);
      };

      socket.onclose = () => {
        clearTimeout(timer);
        this.#state = "closed";
        this.#closeHandler?.();
      };
    }).finally(() => {
      this.#connectPromise = null;
    });

    return this.#connectPromise;
  }

  onMessage(handler) {
    this.#messageHandler = handler;
    return () => {
      if (this.#messageHandler === handler) this.#messageHandler = null;
    };
  }

  onText(handler) {
    this.#textHandlers.add(handler);
    if (this.#textBuffer.length) {
      const buffered = this.#textBuffer;
      this.#textBuffer = [];
      for (const data of buffered) {
        try {
          handler(data);
        } catch (err) {
          console.error("[WebSocketTransport] text handler failed:", err);
        }
      }
    }
    return () => {
      this.#textHandlers.delete(handler);
    };
  }

  onClose(handler) {
    this.#closeHandler = handler;
    return () => {
      if (this.#closeHandler === handler) this.#closeHandler = null;
    };
  }

  async send(data) {
    if (this.#state !== "open") throw new Error("websocket is not open");
    this.#socket.send(data);
  }

  close() {
    if (this.#state === "closed" && !this.#socket) return;
    this.#state = "closed";
    try {
      this.#socket?.close();
    } catch {
      // ignore
    }
    this.#socket = null;
  }

  #handleMessage(data) {
    if (typeof data === "string") {
      if (this.#textHandlers.size === 0) {
        this.#textBuffer.push(data);
        if (this.#textBuffer.length > 16) this.#textBuffer.shift();
        return;
      }
      for (const handler of this.#textHandlers) {
        try {
          handler(data);
        } catch (err) {
          console.error("[WebSocketTransport] text handler failed:", err);
        }
      }
      return;
    }
    if (!this.#messageHandler) return;
    if (data instanceof ArrayBuffer) {
      this.#messageHandler(new Uint8Array(data));
      return;
    }
    if (typeof Blob !== "undefined" && data instanceof Blob) {
      data.arrayBuffer().then((buffer) => {
        this.#messageHandler?.(new Uint8Array(buffer));
      });
    }
  }
}
