import test from "node:test";
import assert from "node:assert/strict";

import { createIdentity } from "../../nos/peer/identity.js";
import { PeerHub } from "../../nos/peer/hub/hub.js";
import { RelayMux } from "../../nos/peer/relay/mux.js";

const enc = (s) => new TextEncoder().encode(s);
const dec = (b) => new TextDecoder().decode(b);
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeTransport {
  constructor(name) {
    this.name = name;
    this.peer = null;
    this.handler = null;
    this.sent = [];
  }
  attach(peer) {
    this.peer = peer;
  }
  onMessage(handler) {
    this.handler = handler;
    return () => {};
  }
  onClose() {
    return () => {};
  }
  onText() {
    return () => {};
  }
  async send(data) {
    this.sent.push(data);
    this.peer?.deliver(data);
  }
  deliver(data) {
    this.handler?.(data.slice());
  }
  close() {}
}

class FakePort {
  constructor() {
    this.messages = [];
    this.onmessage = null;
  }
  postMessage(message) {
    this.messages.push(message);
  }
  start() {}
}

test("PeerHub encrypts app payloads end-to-end when identities are configured", async () => {
  const alice = await createIdentity();
  const bob = await createIdentity();

  const ta = new FakeTransport("a");
  const tb = new FakeTransport("b");
  ta.attach(tb);
  tb.attach(ta);

  const muxA = new RelayMux({ transport: ta, localId: alice.userId });
  const muxB = new RelayMux({ transport: tb, localId: bob.userId });
  const hubA = new PeerHub({
    mux: muxA,
    identity: alice,
    resolvePublicKey: async (peerId) => (peerId === bob.userId ? bob.publicKey : null),
  });
  const hubB = new PeerHub({
    mux: muxB,
    identity: bob,
    resolvePublicKey: async (peerId) => (peerId === alice.userId ? alice.publicKey : null),
  });

  const portA = new FakePort();
  const portB = new FakePort();
  hubA.registerPort(portA);
  hubB.registerPort(portB);

  await hubA.send(bob.userId, enc("top-secret"));
  await new Promise((resolve) => setTimeout(resolve, 80));

  const received = portB.messages.filter((m) => m.type === "message");
  assert.equal(received.length, 1);
  assert.equal(dec(received[0].payload), "top-secret");

  // 线路上不应出现明文
  const wire = ta.sent[0];
  assert.equal(dec(wire).includes("top-secret"), false);
  assert.ok(wire.byteLength > "top-secret".length);

  hubA.close();
  hubB.close();
});
