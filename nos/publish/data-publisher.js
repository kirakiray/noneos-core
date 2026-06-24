// DataPublisher — 数据发布管理器
//
// 基于 LocalUser 实现文件的分块发布、清单/块数据的请求与响应。
// 协议消息类型为 "data_publish"，内容本身公开，不走 E2EE 加密。
//
// 消息流向：
// - 请求方 -> 应答方：通过 remoteUser.send(sessionId, msg, true)（raw 模式跳过加密）
// - 应答方 -> 请求方：通过 server.relayToUserViaServer(url, fromUserId, fromSessionId, data)
//   - manifest / error 响应为 JSON，走文本 relay
//   - chunk 二进制数据走二进制 relay（接收方 recalc hash 识别）

import {
  saveChunk,
  getChunk,
  saveManifest,
  getManifest,
} from "./db.js";
import { verifyData } from "../crypto/crypto-verify.js";
import { getHash } from "../util/hash/get-hash.js";

// 分块大小：255KB
const CHUNK_SIZE = 255 * 1024;

// 请求超时时间
const MANIFEST_TIMEOUT = 10000;
const CHUNK_TIMEOUT = 15000;

/**
 * 判断是否为二进制数据
 */
function isBinary(data) {
  return (
    data instanceof ArrayBuffer ||
    ArrayBuffer.isView(data) ||
    data instanceof Blob
  );
}

/**
 * 将二进制数据转换为独立的 Uint8Array（拷贝，避免引用大 frame buffer）
 */
function toUint8Array(data) {
  if (data instanceof Uint8Array) {
    return new Uint8Array(data); // 拷贝
  }
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  if (data instanceof Blob) {
    // 异步场景应由调用方先 arrayBuffer()
    throw new Error("Blob should be converted to ArrayBuffer before calling");
  }
  throw new Error("Unsupported binary data type");
}

/**
 * 判断对象是否为 manifest（已签名的文件清单）
 * manifest 结构：{ fileHash, chunkHashes, fileName, fileSize, signTime, publicKey, signature }
 */
function isManifest(obj) {
  return (
    obj &&
    typeof obj === "object" &&
    !Array.isArray(obj) &&
    !obj.type && // 协议消息带 type，manifest 不带
    typeof obj.fileHash === "string" &&
    Array.isArray(obj.chunkHashes) &&
    typeof obj.signature === "string" &&
    typeof obj.publicKey === "string"
  );
}

/**
 * 数据发布管理器
 *
 * 职责：
 * 1. publish(file) —— 将本地文件分块、计算哈希、签名后存入 DB，返回 manifest
 * 2. start() —— 监听 localUser 的 message 事件，响应 incoming 的 manifest/chunk 请求
 * 3. requestManifest / requestChunk —— 向远程用户请求清单或块数据
 * 4. assembleFile —— 从本地 DB 读取所有 chunk 拼装为 Blob
 */
export class DataPublisher {
  #user; // LocalUser 实例
  #unbind; // start() 绑定的解绑函数
  #manifestRequestMap = new Map(); // fileHash -> { resolve, reject, timer }
  #chunkRequestMap = new Map(); // chunkHash -> Promise（去重并发请求）

  /**
   * @param {import("../user/user.js").LocalUser} localUser - 本地用户实例
   */
  constructor(localUser) {
    this.#user = localUser;
  }

  /**
   * 启动监听：绑定 localUser 的 "message" 事件，处理 data_publish 协议消息
   */
  start() {
    if (this.#unbind) return;

    this.#unbind = this.#user.bind("message", (event) => {
      this.#handleMessage(event.detail).catch((err) => {
        console.warn("[DataPublisher] message handler error:", err.message);
      });
    });
  }

  /**
   * 停止监听
   */
  stop() {
    if (this.#unbind) {
      this.#unbind();
      this.#unbind = null;
    }
    // 清理所有进行中的请求
    for (const { reject, timer } of this.#manifestRequestMap.values()) {
      clearTimeout(timer);
      reject(new Error("DataPublisher stopped"));
    }
    this.#manifestRequestMap.clear();
    this.#chunkRequestMap.clear();
  }

  /**
   * 处理 incoming message 事件
   * 仅处理文本 relay（JSON），二进制帧由 user.js 解析后分发到 RemoteUser
   */
  async #handleMessage(detail) {
    // 二进制数据（chunk 响应）由 requestChunk 的 remoteUser 监听器处理，这里跳过
    if (typeof detail.data !== "string") return;

    let parsed;
    try {
      parsed = JSON.parse(detail.data);
    } catch {
      return;
    }

    if (parsed.type !== "relay") return;

    const data = parsed.data;
    if (!data || typeof data !== "object") return;

    const fromUserId = parsed.from_user_id;
    const fromSessionId = parsed.from_session_id;
    const url = detail.url;

    // 1. manifest 响应（直接发送的 manifest 对象）
    if (isManifest(data)) {
      await this.#handleManifestResponse(data);
      return;
    }

    // 2. data_publish 协议消息
    if (data.type !== "data_publish") return;

    if (data.action === "request_manifest") {
      await this.#handleRequestManifest(
        data.fileHash,
        fromUserId,
        fromSessionId,
        url,
      );
    } else if (data.action === "request_chunk") {
      await this.#handleRequestChunk(
        data.chunkHash,
        fromUserId,
        fromSessionId,
        url,
      );
    } else if (data.action === "manifest_response") {
      // manifest 不存在的错误响应
      this.#rejectManifestRequest(
        data.fileHash,
        new Error(data.error || "Manifest not found"),
      );
    }
    // chunk_response 的错误响应会同时分发到 RemoteUser，由 requestChunk 处理
  }

  // ───── 发布 ─────

  /**
   * 发布文件：分块、计算哈希、签名、存入 DB
   * @param {File|Blob} file - 要发布的文件
   * @returns {Promise<Object>} manifest 对象
   */
  async publish(file) {
    const fileName = file.name || "unnamed";
    const fileSize = file.size;
    const chunkHashes = [];

    // 按 255KB 分块读取，避免一次性读入大文件爆内存
    for (let start = 0; start < fileSize; start += CHUNK_SIZE) {
      const end = Math.min(start + CHUNK_SIZE, fileSize);
      const blob = file.slice(start, end);
      const buffer = await blob.arrayBuffer();
      const chunkHash = await getHash(buffer);
      chunkHashes.push(chunkHash);
      // 每算完一块立即存入 DB
      await saveChunk(chunkHash, buffer);
    }

    // 将所有 chunkHash 按顺序拼接成字符串，计算 SHA-256 得到 fileHash
    const fileHash = await getHash(chunkHashes.join(""));

    // 构建 manifest 并签名
    const manifest = await this.#user._sign({
      fileHash,
      chunkHashes,
      fileName,
      fileSize,
    });

    await saveManifest(fileHash, manifest);
    return manifest;
  }

  // ───── 请求方：请求 manifest ─────

  /**
   * 请求远程用户的文件清单
   * 先查本地 DB，没有再发起网络请求
   * @param {import("../user/remote-user.js").RemoteUser} remoteUser - 远程用户实例
   * @param {string} sessionId - 目标会话 ID
   * @param {string} fileHash - 文件哈希
   * @returns {Promise<Object>} manifest 对象
   */
  async requestManifest(remoteUser, sessionId, fileHash) {
    // 先查本地
    const local = await getManifest(fileHash);
    if (local) return local;

    // 并发请求去重
    if (this.#manifestRequestMap.has(fileHash)) {
      const existing = this.#manifestRequestMap.get(fileHash);
      return existing.promise;
    }

    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const timer = setTimeout(() => {
      this.#manifestRequestMap.delete(fileHash);
      reject(new Error(`Manifest request timed out: ${fileHash}`));
    }, MANIFEST_TIMEOUT);

    this.#manifestRequestMap.set(fileHash, { resolve, reject, timer, promise });

    try {
      await remoteUser.send(
        sessionId,
        { type: "data_publish", action: "request_manifest", fileHash },
        true,
      );
    } catch (err) {
      clearTimeout(timer);
      this.#manifestRequestMap.delete(fileHash);
      throw err;
    }

    return promise;
  }

  /**
   * 处理 incoming 的 manifest 响应：验签后存入 DB，resolve 请求
   */
  async #handleManifestResponse(manifest) {
    const fileHash = manifest.fileHash;

    // 验证签名（verifyData 会去掉 signature 字段，用 publicKey 验证）
    let isValid = false;
    try {
      isValid = await verifyData(manifest);
    } catch (err) {
      console.warn("[DataPublisher] manifest verify error:", err.message);
    }

    if (!isValid) {
      console.warn(
        `[DataPublisher] Manifest signature invalid for ${fileHash}, discarding`,
      );
      this.#rejectManifestRequest(fileHash, new Error("Invalid manifest signature"));
      return;
    }

    await saveManifest(fileHash, manifest);
    this.#resolveManifestRequest(fileHash, manifest);
  }

  #resolveManifestRequest(fileHash, manifest) {
    const entry = this.#manifestRequestMap.get(fileHash);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#manifestRequestMap.delete(fileHash);
    entry.resolve(manifest);
  }

  #rejectManifestRequest(fileHash, error) {
    const entry = this.#manifestRequestMap.get(fileHash);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#manifestRequestMap.delete(fileHash);
    entry.reject(error);
  }

  // ───── 请求方：请求 chunk ─────

  /**
   * 请求远程用户的块数据
   * 先查本地 DB，没有再发起网络请求
   * @param {import("../user/remote-user.js").RemoteUser} remoteUser - 远程用户实例
   * @param {string} sessionId - 目标会话 ID
   * @param {string} chunkHash - 块哈希
   * @returns {Promise<ArrayBuffer>} 块二进制数据
   */
  async requestChunk(remoteUser, sessionId, chunkHash) {
    // 先查本地
    const local = await getChunk(chunkHash);
    if (local) return local;

    // 并发请求去重
    if (this.#chunkRequestMap.has(chunkHash)) {
      return this.#chunkRequestMap.get(chunkHash);
    }

    const promise = this.#doRequestChunk(remoteUser, sessionId, chunkHash);
    this.#chunkRequestMap.set(chunkHash, promise);
    promise.finally(() => this.#chunkRequestMap.delete(chunkHash));
    return promise;
  }

  /**
   * 实际发起 chunk 请求并等待响应
   *
   * 响应路径：
   * - chunk 存在：应答方发送二进制 relay，user.js 解析帧后分发到 RemoteUser，
   *   此处监听 RemoteUser 的 "message" 事件，收到二进制后 recalc hash 匹配
   * - chunk 不存在：应答方发送 JSON 错误，同样分发到 RemoteUser
   */
  async #doRequestChunk(remoteUser, sessionId, chunkHash) {
    return new Promise((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        unbind();
        reject(new Error(`Chunk request timed out: ${chunkHash}`));
      }, CHUNK_TIMEOUT);

      const unbind = remoteUser.bind("message", async (event) => {
        if (settled) return;
        const { data } = event.detail;

        // 二进制 chunk 数据
        if (isBinary(data)) {
          try {
            const bytes = toUint8Array(data);
            // 重新计算 SHA-256 匹配请求的 chunkHash
            const recalcHash = await getHash(bytes);
            if (recalcHash === chunkHash) {
              settled = true;
              clearTimeout(timer);
              unbind();
              // 存入 DB（拷贝为独立 ArrayBuffer）
              const buffer = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              );
              await saveChunk(recalcHash, buffer);
              resolve(buffer);
            }
          } catch (err) {
            // 解析失败，忽略
          }
          return;
        }

        // JSON 错误响应
        if (
          data &&
          typeof data === "object" &&
          data.type === "data_publish" &&
          data.action === "chunk_response" &&
          data.chunkHash === chunkHash
        ) {
          settled = true;
          clearTimeout(timer);
          unbind();
          reject(new Error(data.error || "Chunk not found"));
        }
      });

      // 发送请求（raw 模式跳过 E2EE）
      remoteUser
        .send(
          sessionId,
          { type: "data_publish", action: "request_chunk", chunkHash },
          true,
        )
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          unbind();
          reject(err);
        });
    });
  }

  // ───── 应答方：处理 incoming 请求 ─────

  /**
   * 处理 incoming 的 request_manifest：查 DB，回复 manifest 或 not_found 错误
   */
  async #handleRequestManifest(fileHash, fromUserId, fromSessionId, url) {
    const manifest = await getManifest(fileHash);
    try {
      if (manifest) {
        // 直接发送 manifest 对象
        await this.#user.server.relayToUserViaServer(
          url,
          fromUserId,
          fromSessionId,
          manifest,
        );
      } else {
        await this.#user.server.relayToUserViaServer(
          url,
          fromUserId,
          fromSessionId,
          {
            type: "data_publish",
            action: "manifest_response",
            fileHash,
            error: "not_found",
          },
        );
      }
    } catch (err) {
      console.warn("[DataPublisher] Failed to send manifest response:", err.message);
    }
  }

  /**
   * 处理 incoming 的 request_chunk：查 DB，回复二进制 chunk 或 not_found 错误
   */
  async #handleRequestChunk(chunkHash, fromUserId, fromSessionId, url) {
    const chunkData = await getChunk(chunkHash);
    try {
      if (chunkData) {
        // 发送二进制 chunk 数据（relayToUserViaServer 对二进制自动走二进制 relay）
        await this.#user.server.relayToUserViaServer(
          url,
          fromUserId,
          fromSessionId,
          chunkData,
        );
      } else {
        await this.#user.server.relayToUserViaServer(
          url,
          fromUserId,
          fromSessionId,
          {
            type: "data_publish",
            action: "chunk_response",
            chunkHash,
            error: "not_found",
          },
        );
      }
    } catch (err) {
      console.warn("[DataPublisher] Failed to send chunk response:", err.message);
    }
  }

  // ───── 组装文件 ─────

  /**
   * 从本地 DB 读取 manifest 和所有 chunk，拼装为 Blob
   * @param {string} fileHash - 文件哈希
   * @returns {Promise<{ blob: Blob, fileName: string, fileSize: number }>}
   */
  async assembleFile(fileHash) {
    const manifest = await getManifest(fileHash);
    if (!manifest) {
      throw new Error(`Manifest not found: ${fileHash}`);
    }

    const chunks = [];
    const missing = [];
    for (const chunkHash of manifest.chunkHashes) {
      const chunk = await getChunk(chunkHash);
      if (chunk) {
        chunks.push(chunk);
      } else {
        missing.push(chunkHash);
      }
    }

    if (missing.length > 0) {
      const err = new Error(
        `Missing ${missing.length} chunk(s) for file ${fileHash}`,
      );
      err.missing = missing;
      err.fileHash = fileHash;
      throw err;
    }

    const blob = new Blob(chunks, { type: "application/octet-stream" });
    return {
      blob,
      fileName: manifest.fileName,
      fileSize: manifest.fileSize,
    };
  }
}
