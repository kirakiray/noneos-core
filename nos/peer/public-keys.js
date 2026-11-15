/**
 * 通过已认证的 Relay 连接查询远端用户公钥（Stage 5）。
 *
 * 文本控制帧：
 *   client -> { type:"lookup", requestId, userId }
 *   server -> { type:"pubkey", requestId, userId, publicKey }
 *           | { type:"pubkey-error", requestId, userId, message }
 */
let requestSeq = 0;

export const lookupPublicKey = ({ transport, userId, timeout = 5000 } = {}) => {
  if (!transport || !userId) {
    return Promise.reject(new TypeError("lookupPublicKey requires transport and userId"));
  }
  const bindText = transport.onText
    ? (handler) => transport.onText(handler)
    : (handler) => transport.onMessage(handler);

  const requestId = `pk_${Date.now().toString(36)}_${++requestSeq}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, publicKey) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unbind?.();
      if (error) reject(error);
      else resolve(publicKey);
    };

    const timer = setTimeout(() => finish(new Error("public key lookup timeout")), timeout);
    const unbind = bindText((data) => {
      if (typeof data !== "string") return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.requestId !== requestId) return;
      if (message.type === "pubkey" && message.publicKey) {
        finish(null, message.publicKey);
      } else if (message.type === "pubkey-error") {
        finish(new Error(message.message || "public key not found"));
      }
    });

    transport
      .send(JSON.stringify({ type: "lookup", requestId, userId }))
      .catch((err) => finish(err));
  });
};
