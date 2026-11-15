/**
 * 连接认证（Stage 5）
 *
 * 服务端在 WS 建立后先发 challenge；客户端用身份私钥签名，
 * 服务端校验 userId 与签名后才开始转发 mux 数据。
 */
import { WebSocketTransport } from "./relay/websocket-transport.js";

export const authenticateTransport = async ({
  transport,
  identity,
  timeout = 10000,
} = {}) => {
  if (!transport || !identity) {
    throw new TypeError("authenticateTransport requires transport and identity");
  }

  if (typeof identity.sign !== "function") {
    throw new TypeError("identity.sign must be a function");
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("auth timeout")), timeout);
    const bindText = transport.onText
      ? (handler) => transport.onText(handler)
      : (handler) => transport.onMessage(handler);
    const unbindMessage = bindText(async (data) => {
      if (settled || typeof data !== "string") return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }

      if (message.type === "challenge") {
        try {
          const signature = await identity.sign(message.challenge);
          transport.send(
            JSON.stringify({
              type: "auth",
              userId: identity.userId,
              publicKey: identity.publicKey,
              signature,
            }),
          );
        } catch (err) {
          finish(err);
        }
        return;
      }

      if (message.type === "ready") {
        finish(null);
      } else if (message.type === "auth-error" || message.type === "error") {
        finish(new Error(message.message || "authentication failed"));
      }
    });

    const unbindClose = transport.onClose?.(() => {
      finish(new Error("transport closed during auth"));
    });

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unbindMessage?.();
      unbindClose?.();
      if (error) reject(error);
      else resolve(transport);
    };
  });
};

export const connectWithAuth = async ({ url, identity, timeout } = {}) => {
  if (!identity) throw new TypeError("connectWithAuth requires identity");
  const transport = new WebSocketTransport(url);
  await transport.connect();
  return authenticateTransport({ transport, identity, timeout });
};
