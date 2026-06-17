import { BaseUser } from "../base-user.js";
import { tryEncryptBinary } from "../../crypto/crypto-e2ee.js";

/**
 * 远程用户类，代表通过服务器连接的另一个用户
 * 提供查询对方在线状态、发送数据、接收消息的能力
 */
export class RemoteUser extends BaseUser {
  #userId;
  #localUser;
  #sendCounts = new Map(); // sessionId -> 已发送次数
  #rtcInitiated = new Set(); // 已触发后台 RTC 连接的 sessionId

  /**
   * @param {string} userId - 目标用户的 userId
   * @param {import("./user.js").LocalUser} localUser - 本地用户实例
   */
  constructor(userId, localUser) {
    super();
    if (!userId) {
      throw new Error("userId is required");
    }
    this.#userId = userId;
    this.#localUser = localUser;
  }

  /**
   * 获取远程用户的 ID
   */
  get userId() {
    return this.#userId;
  }

  /**
   * 获取远程用户当前的 sessionId 列表
   * 通过查询所有已连接的服务器获取
   * @returns {Promise<string[]>}
   */
  async getSessionIds() {
    const server = this.#localUser.server;
    const urls = server.connectedUrls;
    const allSessions = new Set();

    for (const url of urls) {
      try {
        const result = await server.queryUserOnline(url, this.#userId);
        if (result.online && Array.isArray(result.sessions)) {
          for (const s of result.sessions) {
            allSessions.add(s);
          }
        }
      } catch {
        // 查询失败的服务器跳过
      }
    }

    return [...allSessions];
  }

  /**
   * 发送数据给对方
   *
   * 默认启用 E2EE 加密：如果双方已完成名片交换，
   * 数据会用 ECDH 派生密钥 + AES-GCM 加密后传输，
   * 密文走二进制帧通道，服务端无法窥探明文内容。
   *
   * 内部使用 `raw=true` 绕过加密（如名片协议自身的交换过程）。
   *
   * 优先尝试 RTC 直连：若与目标 session 的 DataChannel 已就绪，
   * 直接通过 WebRTC 发送；否则后台静默发起 RTC 配对，
   * 本次及配对完成前继续走服务器中转兜底。
   *
   * @param {string} sessionId - 目标会话 ID
   * @param {*} data - 要发送的数据（JSON 可序列化值）
   * @param {boolean} [raw=false] - 内部使用，设为 true 跳过加密
   * @returns {Promise<Object>} 发送结果
   */
  async send(sessionId, data, raw = false) {
    // 优先走 RTC DataChannel
    const dc = this.#localUser.rtc.getChannel(this.#userId, sessionId);
    if (dc?.readyState === "open") {
      const payload = await this.#preparePayload(data, raw);
      dc.send(payload);
      return { status: "ok", via: "rtc" };
    }

    // 第一次 send 只走服务器中转，不触发 RTC，避免首次通信被信令干扰。
    // 从第二次 send 开始，后台静默触发 RTC 配对（失败无感）。
    const sentCount = this.#sendCounts.get(sessionId) || 0;
    this.#sendCounts.set(sessionId, sentCount + 1);
    if (sentCount >= 1 && !this.#rtcInitiated.has(sessionId)) {
      this.#rtcInitiated.add(sessionId);
      this.#localUser.rtc.connect(this.#userId, sessionId).catch(() => {});
    }

    // RTC 未就绪，走服务器中转
    return this.#sendViaServer(sessionId, data, raw);
  }

  /**
   * 准备通过 DataChannel 发送的 payload。
   * 对象默认尝试 E2EE 加密；加密失败或明文模式则序列化为 JSON 字符串。
   * 二进制类型原样返回。
   */
  async #preparePayload(data, raw) {
    const isPlainObject =
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      !ArrayBuffer.isView(data) &&
      !(data instanceof Blob);

    if (!raw && isPlainObject) {
      const encrypted = await tryEncryptBinary(
        this.#localUser,
        this.#userId,
        data,
      );
      if (encrypted !== null) {
        return encrypted;
      }
      return JSON.stringify(data);
    }

    if (
      typeof data !== "string" &&
      !(data instanceof ArrayBuffer) &&
      !ArrayBuffer.isView(data) &&
      !(data instanceof Blob)
    ) {
      return JSON.stringify(data);
    }

    return data;
  }

  /**
   * 通过服务器中转发送数据（保持原有 E2EE 与明文逻辑）
   */
  async #sendViaServer(sessionId, data, raw) {
    // 仅对纯对象启用 E2EE 加密（跳过数组、Uint8Array 等二进制数据）
    if (
      !raw &&
      data &&
      typeof data === "object" &&
      !Array.isArray(data) &&
      !ArrayBuffer.isView(data) &&
      !(data instanceof Blob)
    ) {
      const encrypted = await tryEncryptBinary(
        this.#localUser,
        this.#userId,
        data,
      );
      if (encrypted !== null) {
        // 加密成功，以二进制帧形式发送，零 base64 开销
        return this.#localUser.server.sendToUser(
          this.#userId,
          sessionId,
          encrypted,
        );
      }
    }
    return this.#localUser.server.sendToUser(this.#userId, sessionId, data);
  }
}
