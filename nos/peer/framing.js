/**
 * PeerSession 线路帧格式（Stage 1）
 *
 * 16 字节头部 + payload，全部大端：
 *   0      version (u8)
 *   1      type (u8)      0=data 1=ack 2=ping 3=pong
 *   2-3    flags (u16)    bit0 = reliable
 *   4-7    seq (u32)      数据帧序号（从 1 开始）
 *   8-11   ack (u32)      累积确认（已连续收到的最大 seq）
 *   12-15  length (u32)   payload 字节数
 *
 * 链路只负责搬运字节；序号、ACK、重传、去重由 PeerSession 负责。
 */

export const FRAME_VERSION = 1;
export const FRAME_HEADER_SIZE = 16;
export const MAX_PAYLOAD_BYTES = 1024 * 1024;

export const FrameType = Object.freeze({
  DATA: 0,
  ACK: 1,
  PING: 2,
  PONG: 3,
});

export const FrameFlags = Object.freeze({
  RELIABLE: 1 << 0,
});

const assertUint32 = (value, name) => {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new RangeError(`${name} must be a uint32, got ${value}`);
  }
};

export const encodeFrame = ({
  type,
  flags = 0,
  seq = 0,
  ack = 0,
  payload = new Uint8Array(0),
} = {}) => {
  if (!Number.isInteger(type) || type < 0 || type > 0xff) {
    throw new RangeError(`type must be a uint8, got ${type}`);
  }
  assertUint32(flags, "flags");
  if (flags > 0xffff) throw new RangeError("flags must be uint16");
  assertUint32(seq, "seq");
  assertUint32(ack, "ack");

  const bytes =
    payload instanceof Uint8Array
      ? payload
      : new Uint8Array(payload?.buffer ?? payload ?? 0);
  if (bytes.byteLength > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`payload too large: ${bytes.byteLength} bytes`);
  }

  const buffer = new ArrayBuffer(FRAME_HEADER_SIZE + bytes.byteLength);
  const view = new DataView(buffer);
  view.setUint8(0, FRAME_VERSION);
  view.setUint8(1, type);
  view.setUint16(2, flags);
  view.setUint32(4, seq);
  view.setUint32(8, ack);
  view.setUint32(12, bytes.byteLength);

  const out = new Uint8Array(buffer);
  out.set(bytes, FRAME_HEADER_SIZE);
  return out;
};

export const decodeFrame = (input) => {
  const bytes =
    input instanceof Uint8Array
      ? input
      : input instanceof ArrayBuffer
        ? new Uint8Array(input)
        : new Uint8Array(input?.buffer ?? input, input?.byteOffset ?? 0, input?.byteLength ?? 0);

  if (bytes.byteLength < FRAME_HEADER_SIZE) {
    throw new RangeError(`frame too short: ${bytes.byteLength} bytes`);
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint8(0);
  if (version !== FRAME_VERSION) {
    throw new RangeError(`unsupported frame version: ${version}`);
  }

  const type = view.getUint8(1);
  const flags = view.getUint16(2);
  const seq = view.getUint32(4);
  const ack = view.getUint32(8);
  const length = view.getUint32(12);

  if (length > MAX_PAYLOAD_BYTES) {
    throw new RangeError(`payload too large: ${length} bytes`);
  }
  if (FRAME_HEADER_SIZE + length !== bytes.byteLength) {
    throw new RangeError(
      `frame length mismatch: header=${length} actual=${bytes.byteLength - FRAME_HEADER_SIZE}`,
    );
  }

  return {
    version,
    type,
    flags,
    seq,
    ack,
    payload: bytes.slice(FRAME_HEADER_SIZE),
  };
};
