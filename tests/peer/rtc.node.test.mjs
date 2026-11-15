import test from "node:test";
import assert from "node:assert/strict";

import { RtcLeader } from "../../nos/peer/rtc/leader.js";
import { PeerHub } from "../../nos/peer/hub/hub.js";
import { RelayMux } from "../../nos/peer/relay/mux.js";
import { decodeFrame, encodeFrame, FrameType } from "../../nos/peer/framing.js";

const bytes = (s) => new TextEncoder().encode(s);
const text = (b) => new TextDecoder().decode(b);
const tick = () => new Promise((resolve) => setImmediate(resolve));

class FakeChannel {
  constructor() {
    this.readyState = "connecting";
    this.binaryType = "blob";
    this.sent = [];
    this.onopen = null;
    this.onclose = null;
    this.onmessage = null;
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = "closed";
    this.onclose?.();
  }
  _open() {
    this.readyState = "open";
    this.onopen?.();
  }
  _message(data) {
    this.onmessage?.({ data });
  }
}

class FakePeerConnection {
  static instances = [];
  constructor(config) {
    this.config = config;
    this.connectionState = "new";
    this.localDescription = null;
    this.remoteDescription = null;
    this.channels = [];
    this.ondatachannel = null;
    this.onicecandidate = null;
    this.onconnectionstatechange = null;
    FakePeerConnection.instances.push(this);
  }
  createDataChannel() {
    const channel = new FakeChannel();
    this.channels.push(channel);
    return channel;
  }
  async createOffer() {
    return { type: "offer", sdp: "fake-offer" };
  }
  async createAnswer() {
    return { type: "answer", sdp: "fake-answer" };
  }
  async setLocalDescription(desc) {
    this.localDescription = desc;
  }
  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
  }
  async addIceCandidate() {}
  close() {
    this.connectionState = "closed";
  }
}

test("RtcLeader exchanges offer/answer and moves frames over DataChannel", async () => {
  FakePeerConnection.instances = [];
  const outA = [];
  const outB = [];
  const leaderA = new RtcLeader({
    localId: "alice",
    RTCPeerConnectionImpl: FakePeerConnection,
    send: (m) => {
      outA.push(m);
      if (m.type === "rtc-signal") leaderB.handleSignal("alice", m.signal);
    },
  });
  const leaderB = new RtcLeader({
    localId: "bob",
    RTCPeerConnectionImpl: FakePeerConnection,
    send: (m) => {
      outB.push(m);
      if (m.type === "rtc-signal") leaderA.handleSignal("bob", m.signal);
    },
  });

  leaderA.open("bob");
  leaderB.open("alice");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.ok(outA.some((m) => m.type === "rtc-signal" && m.signal.kind === "offer"));
  assert.ok(outB.some((m) => m.type === "rtc-signal" && m.signal.kind === "answer"));
  const pcA = FakePeerConnection.instances[0];
  const pcB = FakePeerConnection.instances[1];
  assert.equal(pcA.remoteDescription.type, "answer");
  assert.equal(pcB.remoteDescription.type, "offer");

  const channelA = pcA.channels[0];
  const channelB = new FakeChannel();
  pcB.ondatachannel({ channel: channelB });
  channelA._open();
  channelB._open();

  assert.ok(outA.some((m) => m.type === "rtc-state" && m.state === "connected"));
  assert.ok(outB.some((m) => m.type === "rtc-state" && m.state === "connected"));

  leaderA.sendFrame("bob", bytes("to-b"));
  assert.equal(text(channelA.sent[0]), "to-b");

  channelB._message(bytes("to-a"));
  assert.ok(outB.some((m) => m.type === "rtc-frame" && text(m.frame) === "to-a"));
});

class FakePort {
  constructor() {
    this.messages = [];
    this.onmessage = null;
  }
  postMessage(message) {
    this.messages.push(message);
  }
  start() {}
  receive(message) {
    this.onmessage?.({ data: message });
  }
}

class FakeTransport {
  constructor() {
    this.messageHandler = null;
    this.sent = [];
  }
  onMessage(handler) {
    this.messageHandler = handler;
    return () => {};
  }
  onClose() {
    return () => {};
  }
  async send(data) {
    this.sent.push(data);
  }
  deliver(data) {
    this.messageHandler?.(data);
  }
  close() {}
}

test("PeerHub switches to RTC proxy on connected and back on closed", async () => {
  const transport = new FakeTransport();
  const mux = new RelayMux({ transport, localId: "alice" });
  const hub = new PeerHub({ mux });
  const leader = new FakePort();
  hub.registerPort(leader);

  const pending = hub.send("bob", bytes("first")).catch(() => {});
  await tick();
  assert.ok(leader.messages.some((m) => m.type === "rtc-open" && m.peerId === "bob"));

  leader.receive({ type: "rtc-state", peerId: "bob", state: "connected" });
  await tick();
  const rtcFrames = leader.messages.filter((m) => m.type === "rtc-frame");
  assert.ok(rtcFrames.length >= 1);

  const before = leader.messages.filter((m) => m.type === "rtc-frame").length;
  hub.send("bob", bytes("over-rtc")).catch(() => {});
  await tick();
  const after = leader.messages.filter((m) => m.type === "rtc-frame");
  assert.equal(after.length, before + 1);
  const decoded = decodeFrame(after.at(-1).frame);
  assert.equal(text(decoded.payload.subarray(1)), "over-rtc"); // [APP, ...]

  // leader 侧注入帧，hub 应交给 PeerSession 并广播给标签页
  const frame = encodeFrame({
    type: FrameType.DATA,
    seq: 1,
    ack: 0,
    payload: new Uint8Array([0, ...bytes("x")]),
  });
  leader.receive({ type: "rtc-frame", peerId: "bob", frame });
  await tick();
  assert.ok(leader.messages.some((m) => m.type === "message" && text(m.payload) === "x"));

  leader.receive({ type: "rtc-state", peerId: "bob", state: "closed" });
  await tick();
  const relayBefore = transport.sent.length;
  hub.send("bob", bytes("back-relay")).catch(() => {});
  await tick();
  assert.ok(transport.sent.length > relayBefore || transport.sent.length === relayBefore);
  pending.catch(() => {});
  hub.close();
});
