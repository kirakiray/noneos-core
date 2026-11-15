import test from "node:test";
import assert from "node:assert/strict";

import { RelayMux, decodeMuxFrame, encodeMuxFrame } from "../../nos/peer/relay/mux.js";
import { WebSocketTransport } from "../../nos/peer/relay/websocket-transport.js";
import { PeerHub } from "../../nos/peer/hub/hub.js";
import { PeerSession } from "../../nos/peer/session.js";
import { encodeFrame, FrameType } from "../../nos/peer/framing.js";

const tick = () => new Promise((resolve) => setImmediate(resolve));
const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);

class FakeTransport {
  constructor(name) {
    this.name = name;
    this.state = "open";
    this.peer = null;
    this.messageHandler = null;
    this.closeHandler = null;
    this.sent = [];
  }
  attach(peer) {
    this.peer = peer;
  }
  onMessage(handler) {
    this.messageHandler = handler;
    return () => {
      if (this.messageHandler === handler) this.messageHandler = null;
    };
  }
  onClose(handler) {
    this.closeHandler = handler;
    return () => {
      if (this.closeHandler === handler) this.closeHandler = null;
    };
  }
  async send(data) {
    this.sent.push(data);
    this.peer?.deliver(data);
  }
  deliver(data) {
    this.messageHandler?.(data.slice());
  }
  close() {
    if (this.state === "closed") return;
    this.state = "closed";
    this.closeHandler?.();
  }
}

const createTransportPair = () => {
  const a = new FakeTransport("a");
  const b = new FakeTransport("b");
  a.attach(b);
  b.attach(a);
  return [a, b];
};

class FakePort {
  constructor(name) {
    this.name = name;
    this.messages = [];
    this.onmessage = null;
    this.started = false;
    this.closed = false;
  }
  postMessage(message) {
    this.messages.push(message);
  }
  start() {
    this.started = true;
  }
  close() {
    this.closed = true;
  }
  receive(message) {
    this.onmessage?.({ data: message });
  }
}

test("mux frame roundtrip and demultiplexing", () => {
  const inner = encodeFrame({ type: FrameType.DATA, seq: 1, ack: 0, payload: bytes("x") });
  const encoded = encodeMuxFrame({ from: "alice", to: "bob", frame: inner });
  const decoded = decodeMuxFrame(encoded);
  assert.equal(decoded.from, "alice");
  assert.equal(decoded.to, "bob");
  assert.deepEqual([...decoded.frame], [...inner]);

  const [ta] = createTransportPair();
  const mux = new RelayMux({ transport: ta, localId: "alice" });
  const bob = mux.link("bob");
  const carol = mux.link("carol");
  const gotBob = [];
  const gotCarol = [];
  bob.onFrame((frame) => gotBob.push(decodeMuxFrame(encodeMuxFrame({ from: "carol", to: "alice", frame })) && frame));
  carol.onFrame((frame) => gotCarol.push(frame));

  ta.deliver(encodeMuxFrame({ from: "carol", to: "alice", frame: inner }));
  assert.equal(gotBob.length, 0);
  assert.equal(gotCarol.length, 1);
});

test("PeerSession works over multiplexed relay links", async () => {
  const [ta, tb] = createTransportPair();
  const muxA = new RelayMux({ transport: ta, localId: "alice" });
  const muxB = new RelayMux({ transport: tb, localId: "bob" });
  const sessionA = new PeerSession({ link: muxA.link("bob") }).start();
  const sessionB = new PeerSession({ link: muxB.link("alice") }).start();

  const received = [];
  sessionB.onMessage((payload, meta) => received.push({ text: text(payload), seq: meta.seq }));

  const result = await sessionA.send(bytes("hello"));
  await tick();
  assert.equal(result.acked, true);
  assert.deepEqual(received, [{ text: "hello", seq: 1 }]);
});

test("PeerHub broadcasts to all tabs and accepts sends from any tab", async () => {
  const [ta, tb] = createTransportPair();
  const muxA = new RelayMux({ transport: ta, localId: "alice" });
  const muxB = new RelayMux({ transport: tb, localId: "bob" });
  const hubA = new PeerHub({ mux: muxA });
  const hubB = new PeerHub({ mux: muxB });

  const tabA1 = new FakePort("a1");
  const tabA2 = new FakePort("a2");
  const tabB = new FakePort("b");
  hubA.registerPort(tabA1);
  hubA.registerPort(tabA2);
  hubB.registerPort(tabB);

  await hubA.send("bob", bytes("from-a"));
  await tick();
  assert.equal(tabB.messages.filter((m) => m.type === "message").length, 1);
  assert.equal(text(tabB.messages.at(-1).payload), "from-a");

  tabA1.receive({
    type: "send",
    id: 42,
    peerId: "bob",
    data: bytes("from-tab"),
    reliable: true,
  });
  await tick();
  await tick();
  assert.ok(tabA1.messages.some((m) => m.type === "sent" && m.id === 42));
  assert.equal(text(tabB.messages.at(-1).payload), "from-tab");

  await hubB.send("alice", bytes("from-b"));
  await tick();
  const messagesA1 = tabA1.messages.filter((m) => m.type === "message");
  const messagesA2 = tabA2.messages.filter((m) => m.type === "message");
  assert.equal(messagesA1.at(-1) && text(messagesA1.at(-1).payload), "from-b");
  assert.equal(messagesA2.at(-1) && text(messagesA2.at(-1).payload), "from-b");
});

test("WebSocketTransport connects, sends and receives binary frames", async () => {
  class MockSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.binaryType = "blob";
      MockSocket.instance = this;
      queueMicrotask(() => this.onopen?.());
    }
    send(data) {
      this.sent.push(data);
    }
    close() {
      this.onclose?.();
    }
  }

  const transport = new WebSocketTransport("ws://relay.test", {
    WebSocketImpl: MockSocket,
    connectTimeout: 1000,
  });
  const received = [];
  transport.onMessage((data) => received.push(data));

  await transport.connect();
  assert.equal(transport.state, "open");
  await transport.send(bytes("ping"));
  assert.deepEqual([...MockSocket.instance.sent[0]], [...bytes("ping")]);

  MockSocket.instance.onmessage({ data: bytes("pong").buffer });
  assert.equal(text(received[0]), "pong");
  transport.close();
  assert.equal(transport.state, "closed");
});
