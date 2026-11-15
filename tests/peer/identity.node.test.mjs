import test from "node:test";
import assert from "node:assert/strict";

import {
  createIdentity,
  identityFromKeys,
  identityToJSON,
  verifySignature,
} from "../../nos/peer/identity.js";
import { authenticateTransport } from "../../nos/peer/auth.js";

test("identity generates stable userId and verifies signatures", async () => {
  const identity = await createIdentity();
  assert.match(identity.userId, /^[0-9a-f]{64}$/);

  const signature = await identity.sign("challenge-1");
  assert.equal(await verifySignature(identity.publicKey, "challenge-1", signature), true);
  assert.equal(await verifySignature(identity.publicKey, "challenge-2", signature), false);

  const restored = await identityFromKeys(identityToJSON(identity));
  assert.equal(restored.userId, identity.userId);
  assert.equal(await verifySignature(restored.publicKey, "challenge-1", await restored.sign("challenge-1")), true);
});

class FakeAuthTransport {
  constructor() {
    this.sent = [];
    this.handler = null;
    this.closeHandler = null;
    this.closed = false;
  }
  onMessage(handler) {
    this.handler = handler;
    return () => {
      if (this.handler === handler) this.handler = null;
    };
  }
  onClose(handler) {
    this.closeHandler = handler;
    return () => {};
  }
  async send(data) {
    this.sent.push(data);
  }
  deliver(data) {
    this.handler?.(data);
  }
  close() {
    this.closed = true;
    this.closeHandler?.();
  }
}

test("authenticateTransport signs the server challenge", async () => {
  const identity = await createIdentity();
  const transport = new FakeAuthTransport();
  const pending = authenticateTransport({ transport, identity, timeout: 1000 });

  transport.deliver(JSON.stringify({ type: "challenge", challenge: "abc123" }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(transport.sent.length, 1);

  const auth = JSON.parse(transport.sent[0]);
  assert.equal(auth.type, "auth");
  assert.equal(auth.userId, identity.userId);
  assert.equal(auth.publicKey, identity.publicKey);
  assert.equal(await verifySignature(identity.publicKey, "abc123", auth.signature), true);

  transport.deliver(JSON.stringify({ type: "ready" }));
  await pending;
  assert.equal(transport.closed, false);
});
