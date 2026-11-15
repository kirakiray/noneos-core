import test from "node:test";
import assert from "node:assert/strict";

import {
  FrameFlags,
  FrameType,
  decodeFrame,
  encodeFrame,
} from "../../nos/peer/framing.js";
import { ReorderBuffer } from "../../nos/peer/reorder-buffer.js";
import { PeerSession } from "../../nos/peer/session.js";
import { FakeLink, createFakeLinkPair } from "../../nos/peer/links/fake-link.js";

class FakeTimers {
  constructor() {
    this.now = 0;
    this.tasks = new Map();
    this.nextId = 1;
  }
  setTimeout(fn, ms) {
    const id = this.nextId++;
    this.tasks.set(id, { fn, at: this.now + ms });
    return id;
  }
  clearTimeout(id) {
    this.tasks.delete(id);
  }
  advance(ms) {
    this.now += ms;
    for (const [id, task] of [...this.tasks]) {
      if (task.at <= this.now) {
        this.tasks.delete(id);
        task.fn();
      }
    }
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test("frame roundtrip and invalid frames", () => {
  const payload = new TextEncoder().encode("hello");
  const bytes = encodeFrame({
    type: FrameType.DATA,
    flags: FrameFlags.RELIABLE,
    seq: 7,
    ack: 3,
    payload,
  });
  const decoded = decodeFrame(bytes);
  assert.equal(decoded.type, FrameType.DATA);
  assert.equal(decoded.seq, 7);
  assert.equal(decoded.ack, 3);
  assert.equal(new TextDecoder().decode(decoded.payload), "hello");

  const badVersion = bytes.slice();
  badVersion[0] = 99;
  assert.throws(() => decodeFrame(badVersion), /version/);
  assert.throws(() => decodeFrame(bytes.slice(0, 8)), /too short/);
});

test("reorder buffer delivers in order and drops duplicates", () => {
  const reorder = new ReorderBuffer({ windowSize: 8 });
  const payload = (n) => new Uint8Array([n]);

  assert.equal(reorder.accept(2, payload(2)).status, "buffered");
  const first = reorder.accept(1, payload(1));
  assert.equal(first.status, "deliver");
  assert.deepEqual(first.messages.map((m) => m.seq), [1, 2]);
  assert.equal(reorder.accept(1, payload(1)).status, "duplicate");
  assert.equal(reorder.accept(99, payload(99)).status, "out-of-window");
  assert.equal(reorder.receivedThrough, 2);
});

test("reliable send resolves after ack and delivers once", async () => {
  const [linkA, linkB] = createFakeLinkPair();
  const sessionA = new PeerSession({ link: linkA, ackTimeout: 100 }).start();
  const sessionB = new PeerSession({ link: linkB, ackTimeout: 100 }).start();

  const received = [];
  sessionB.onMessage((payload, meta) => {
    received.push({ text: new TextDecoder().decode(payload), seq: meta.seq });
  });

  const result = await sessionA.send(new TextEncoder().encode("hello"));
  await tick();

  assert.deepEqual(result, { seq: 1, acked: true, attempts: 1 });
  assert.deepEqual(received, [{ text: "hello", seq: 1 }]);
  assert.equal(sessionA.pendingCount, 0);
});

test("lost packet is retransmitted and duplicate delivery is suppressed", async () => {
  const timersA = new FakeTimers();
  const timersB = new FakeTimers();
  const [linkA, linkB] = createFakeLinkPair();
  const sessionA = new PeerSession({
    link: linkA,
    ackTimeout: 100,
    maxRetries: 2,
    timers: timersA,
  }).start();
  const sessionB = new PeerSession({ link: linkB, timers: timersB }).start();

  const received = [];
  sessionB.onMessage((payload, meta) => received.push(meta.seq));

  linkA.dropNext = 1;
  linkA.duplicateNext = 2;
  const pending = sessionA.send(new TextEncoder().encode("retry"));
  await tick();
  assert.equal(sessionA.pendingCount, 1);

  timersA.advance(100);
  const result = await pending;

  assert.equal(result.acked, true);
  assert.equal(result.attempts, 2);
  assert.deepEqual(received, [1]);
});

test("ack timeout rejects after max retries and close clears outbox", async () => {
  const timers = new FakeTimers();
  const link = new FakeLink();
  const session = new PeerSession({
    link,
    ackTimeout: 100,
    maxRetries: 0,
    timers,
  }).start();

  const pending = session.send(new TextEncoder().encode("lost"));
  await tick();
  timers.advance(100);
  await assert.rejects(pending, /ack timeout/);
  assert.equal(session.pendingCount, 0);

  await assert.rejects(
    session.send(new TextEncoder().encode("close")),
    /closed|ack timeout/,
  ).catch(() => {});
  session.close("test close");
  assert.equal(session.state, "closed");
});

test("replaceLink resends unacked messages with the same seq", async () => {
  const timersA = new FakeTimers();
  const [linkA] = createFakeLinkPair();
  const sessionA = new PeerSession({
    link: linkA,
    ackTimeout: 100,
    maxRetries: 2,
    timers: timersA,
  }).start();

  // 对端不存在：第一条不会被 ACK
  const pending = sessionA.send(new TextEncoder().encode("move"));
  await tick();
  assert.equal(sessionA.pendingCount, 1);

  const [linkA2, linkB2] = createFakeLinkPair();
  const sessionB2 = new PeerSession({ link: linkB2 }).start();
  const received = [];
  sessionB2.onMessage((_, meta) => received.push(meta.seq));

  sessionA.replaceLink(linkA2);
  const result = await pending;

  assert.equal(result.seq, 1);
  assert.deepEqual(received, [1]);
});
