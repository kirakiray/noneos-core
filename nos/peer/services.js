/**
 * 服务发现控制帧（Stage 5）
 *
 * client -> { type:"service-register", requestId, appIds:[...] }
 * server -> { type:"services-ok", requestId }
 *
 * client -> { type:"service-lookup", requestId, appId }
 * server -> { type:"services", requestId, appId, userIds:[...] }
 */
let requestSeq = 0;

const requestText = ({ transport, payload, acceptType, timeout }) => {
  const bindText = transport.onText
    ? (handler) => transport.onText(handler)
    : (handler) => transport.onMessage(handler);
  const requestId = `svc_${Date.now().toString(36)}_${++requestSeq}`;

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unbind?.();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("service request timeout")), timeout);
    const unbind = bindText((data) => {
      if (typeof data !== "string") return;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        return;
      }
      if (message.requestId !== requestId) return;
      if (message.type === acceptType) finish(null, message);
      else if (message.type === "error") finish(new Error(message.message || "service error"));
    });
    transport
      .send(JSON.stringify({ ...payload, requestId }))
      .catch((err) => finish(err));
  });
};

export const registerServices = ({ transport, appIds, timeout = 5000 }) => {
  if (!Array.isArray(appIds)) throw new TypeError("appIds must be an array");
  return requestText({
    transport,
    payload: { type: "service-register", appIds },
    acceptType: "services-ok",
    timeout,
  });
};

export const lookupService = ({ transport, appId, timeout = 5000 }) => {
  if (!appId) throw new TypeError("appId is required");
  return requestText({
    transport,
    payload: { type: "service-lookup", appId },
    acceptType: "services",
    timeout,
  }).then((message) => message.userIds || []);
};
