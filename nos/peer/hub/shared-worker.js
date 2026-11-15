/**
 * SharedWorker 入口（Stage 2）
 *
 * 所有标签页共享：一条 Relay WebSocket、一个 RelayMux、一个 PeerHub。
 */
import { RelayMux } from "../relay/mux.js";
import { WebSocketTransport } from "../relay/websocket-transport.js";
import { PeerHub } from "./hub.js";
import { authenticateTransport } from "../auth.js";
import { identityFromKeys } from "../identity.js";
import { lookupPublicKey } from "../public-keys.js";
import { loadOrCreateIdentity } from "../identity-store.js";

let hub = null;
let hubPromise = null;
let localId = null;
let identityPublicKey = null;

const ensureHub = ({ url, identity }) => {
  if (hub) return Promise.resolve(hub);
  if (hubPromise) return hubPromise;

  if (!url) throw new Error("connect requires a relay url");
  if (identity && (!identity.publicKey || !identity.privateKey || !identity.userId)) {
    throw new Error("connect identity is incomplete");
  }

  hubPromise = (async () => {
    const wsUrl = new URL(url, self.location?.href ?? "http://localhost");
    const transport = new WebSocketTransport(wsUrl.toString());
    await transport.connect();
    const identityObject = identity
      ? await identityFromKeys(identity)
      : await loadOrCreateIdentity();
    localId = identityObject.userId;
    identityPublicKey = identityObject.publicKey;
    await authenticateTransport({ transport, identity: identityObject });
    const mux = new RelayMux({ transport, localId });
    hub = new PeerHub({
      mux,
      transport,
      identity: identityObject,
      resolvePublicKey: (peerId) => lookupPublicKey({ transport, userId: peerId }),
    });
    return hub;
  })().catch((err) => {
    hubPromise = null;
    throw err;
  });

  return hubPromise;
};

self.onconnect = (event) => {
  const port = event.ports[0];
  port.start();

  port.onmessage = async (messageEvent) => {
    const message = messageEvent.data;
    if (!message || typeof message !== "object") return;

    if (message.type === "connect") {
      try {
        const current = await ensureHub(message);
        port.postMessage({
          type: "connected",
          id: message.id,
          userId: localId,
          publicKey: identityPublicKey,
        });
        current.registerPort(port);
      } catch (err) {
        port.postMessage({
          type: "connect-error",
          id: message.id,
          message: err?.message || String(err),
        });
      }
      return;
    }

    if (!hub) {
      port.postMessage({
        type: "send-error",
        id: message.id,
        message: "hub is not connected",
      });
    }
  };
};
