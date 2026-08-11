// DataPublisher — 数据发布管理器
//
// 基于 LocalUser 实现文件的分块发布、清单/块数据的请求与响应。
// 协议消息类型为 "data_publish"，内容本身公开，不走 E2EE 加密。
//
// 消息流向（自适应 server relay 与 RTC 双通道）：
// - 请求方 -> 应答方：通过 remoteUser.send(sessionId, msg, true)
//   - RemoteUser.send 内部按 DataChannel 就绪状态自动选择 RTC / server relay
//   - raw=true 跳过 E2EE（协议内容公开）
// - 应答方 -> 请求方：镜像请求来源的通道回复
//   - 请求来自 server relay（detail.url 存在）：通过 server.relayToUserViaServer 回复
//   - 请求来自 RTC（detail.url 为空）：通过 remoteUser.send 回复（RTC 仍在则继续直连，减轻服务器流量）
//
// 双通道接收：
// - LocalUser.message：server relay 通道的入站（文本/二进制 JSON）
// - LocalUser.rtc_message：RTC DataChannel 通道的入站
// 两者都可能收到 data_publish 请求或 manifest 响应；chunk 二进制响应由请求端在 RemoteUser.message 上监听匹配。

import {
  saveChunk,
  getChunk,
  saveManifest,
  getManifest,
} from "./db.js";
import { verifyData } from "../crypto/crypto-verify.js";
import { getHash } from "../util/hash/get-hash.js";
import { asyncPool } from "../util/async-pool.js";

// 分块大小：128KB
const CHUNK_SIZE = 128 * 1024;

// 请求超时时间
const MANIFEST_TIMEOUT = 10000;
const CHUNK_TIMEOUT = 15000;

// fetchFile 拉取缺失 chunk 时的最大并发数。
// 不可无上限并发：单条 relay 消息受服务端 binary_payload_max_size(256KB) 限制，
// 且大量并发在途请求会灌满 RTC DataChannel 发送缓冲、更快触发服务端 relay 失败熔断。
const CHUNK_FETCH_CONCURRENCY = 8;

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
  #unbindRelay; // start() 绑定 LocalUser.message 的解绑函数
  #unbindRtc; // start() 绑定 LocalUser.rtc_message 的解绑函数
  #manifestRequestMap = new Map(); // fileHash -> { resolve, reject, timer }
  #chunkRequestMap = new Map(); // chunkHash -> Promise（去重并发请求）
  #sessionIdCache = new Map(); // remoteUser -> { sessionId, promise }

  /**
   * @param {import("../user/user.js").LocalUser} localUser - 本地用户实例
   */
  constructor(localUser) {
    this.#user = localUser;
  }

  /**
   * 启动监听：同时绑定 server relay 与 RTC DataChannel 两条入站通道，
   * 处理 data_publish 协议消息与 manifest 响应；chunk 二进制响应仍由请求端在 RemoteUser 上匹配。
   * 幂等，重复调用无副作用。
   */
  start() {
    if (this.#unbindRelay || this.#unbindRtc) return;

    // 1. server relay 入站（LocalUser.message：WS 消息，含二进制帧解析后）
    this.#unbindRelay = this.#user.bind("message", (event) => {
      this.#handleRelayMessage(event.detail).catch((err) => {
        console.warn("[DataPublisher] relay handler error:", err.message);
      });
    });

    // 2. RTC 直连入站（LocalUser.rtc_message：DataChannel 消息，尚未解密的原始数据）
    // 用 rtc_message 而非 RemoteUser.message 是为了拿到 fromSessionId 并区分请求来源，
    // 且 rtc_message 优先于 #dispatchToRemote，无需依赖对端 RemoteUser 缓存。
    this.#unbindRtc = this.#user.bind("rtc_message", (event) => {
      this.#handleRtcMessage(event.detail).catch((err) => {
        console.warn("[DataPublisher] rtc handler error:", err.message);
      });
    });
  }

  /**
   * 停止监听
   */
  stop() {
    if (this.#unbindRelay) {
      this.#unbindRelay();
      this.#unbindRelay = null;
    }
    if (this.#unbindRtc) {
      this.#unbindRtc();
      this.#unbindRtc = null;
    }
    // 清理所有进行中的请求
    for (const { reject, timer, unbind } of this.#manifestRequestMap.values()) {
      clearTimeout(timer);
      unbind();
      reject(new Error("DataPublisher stopped"));
    }
    this.#manifestRequestMap.clear();
    this.#chunkRequestMap.clear();
    this.#sessionIdCache.clear();
  }

  /**
   * 处理 server relay 入站消息
   * 只处理文本 relay（JSON），二进制帧由 user.js 解析后分发到 RemoteUser（chunk 响应在请求端匹配）
   */
  async #handleRelayMessage(detail) {
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

    await this.#dispatchIncoming({
      data,
      fromUserId: parsed.from_user_id,
      fromSessionId: parsed.from_session_id,
      url: detail.url, // server relay 来源：非空
    });
  }

  /**
   * 处理 RTC DataChannel 入站消息
   * DataChannel 上发送的是 JSON 字符串（RemoteUser.#preparePayload 对纯对象序列化后 send）
   * 或二进制（E2EE 加密后）。data_publish 协议不加密，因此 JSON 字符串直接可解析。
   * 二进制 chunk 响应由请求端在 RemoteUser.message 上匹配，这里不处理。
   */
  async #handleRtcMessage(detail) {
    const { fromUserId, fromSessionId, data } = detail;
    if (typeof data !== "string") return;

    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }

    if (!parsed || typeof parsed !== "object") return;

    await this.#dispatchIncoming({
      data: parsed,
      fromUserId,
      fromSessionId,
      url: null, // RTC 来源
    });
  }

  /**
   * 统一分发 incoming 消息（不关心传输通道）
   * @param {{ data: Object, fromUserId: string, fromSessionId: string, url: string|null }} ctx
   */
  async #dispatchIncoming(ctx) {
    const { data, fromUserId, fromSessionId, url } = ctx;

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
      await saveChunk(this.#user.namespace, chunkHash, buffer);
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

    await saveManifest(this.#user.namespace, fileHash, manifest);
    return manifest;
  }

  // ───── 请求方：请求 manifest ─────

  /**
   * 解析 sessionId：如果传了就直接用，否则从 remoteUser 自动获取第一个可用会话
   * 带缓存逻辑——首次获取后缓存，后续直接返回缓存值。
   * 并发场景下多个请求共享同一个 Promise，避免重复调用 getSessionIds()。
   * @param {import("../user/remote-user.js").RemoteUser} remoteUser
   * @param {string} [sessionId]
   * @returns {Promise<string>}
   */
  async #resolveSessionId(remoteUser, sessionId) {
    if (sessionId) return sessionId;

    // 1. 检查缓存（已有 resolved sessionId）
    const cached = this.#sessionIdCache.get(remoteUser);
    if (cached && cached.sessionId) {
      console.debug(`[DataPublisher] sessionId cache hit: ${cached.sessionId}`);
      return cached.sessionId;
    }

    // 2. 并发去重：同一 remoteUser 已有正在进行的请求，复用 Promise
    if (cached && cached.promise) {
      console.debug(`[DataPublisher] sessionId concurrent fetch dedup`);
      return cached.promise;
    }

    // 3. 发起实际请求
    console.debug(`[DataPublisher] sessionId cache miss, fetching...`);
    const promise = this.#fetchSessionId(remoteUser);
    this.#sessionIdCache.set(remoteUser, { sessionId: null, promise });

    try {
      const ids = await promise;
      const sid = ids[0];
      console.debug(`[DataPublisher] sessionId resolved: ${sid}`);
      this.#sessionIdCache.set(remoteUser, { sessionId: sid, promise: null });
      return sid;
    } catch (err) {
      this.#sessionIdCache.delete(remoteUser);
      throw err;
    }
  }

  /**
   * 调用 remoteUser.getSessionIds()，获取可用会话列表
   */
  async #fetchSessionId(remoteUser) {
    const ids = await remoteUser.getSessionIds();
    if (!ids || ids.length === 0) {
      throw new Error("No available session from remote user");
    }
    return ids;
  }

  /**
   * 失效指定 remoteUser 的 sessionId 缓存。
   * 如果传了 sessionId，仅当匹配时才失效（误触其他 session 下线不清理）。
   * @param {import("../user/remote-user.js").RemoteUser} remoteUser
   * @param {string} [sessionId]
   */
  #invalidateSessionCache(remoteUser, sessionId) {
    const cached = this.#sessionIdCache.get(remoteUser);
    if (!cached || !cached.sessionId) return;
    if (sessionId && cached.sessionId !== sessionId) return;
    console.debug(
      `[DataPublisher] sessionId cache invalidated: ${cached.sessionId}` +
        (sessionId ? ` (session ${sessionId} closed)` : ""),
    );
    this.#sessionIdCache.delete(remoteUser);
  }

  /**
   * 请求远程用户的文件清单
   * 先查本地 DB，没有再发起网络请求
   * 其他 session 下线不影响当前请求。
   * 当前 session 断开后自动重试一次。
   * @param {import("../user/remote-user.js").RemoteUser} remoteUser - 远程用户实例
   * @param {string} fileHash - 文件哈希
   * @param {string} [sessionId] - 可选，目标会话 ID，不传则自动获取第一个可用会话
   * @returns {Promise<Object>} manifest 对象
   */
  async requestManifest(remoteUser, fileHash, sessionId) {
    // 先查本地
    const local = await getManifest(this.#user.namespace, fileHash);
    if (local) return local;

    // 并发请求去重
    if (this.#manifestRequestMap.has(fileHash)) {
      const existing = this.#manifestRequestMap.get(fileHash);
      return existing.promise;
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.#sendManifestRequest(remoteUser, fileHash, sessionId);
      } catch (err) {
        if (attempt === 0 && err.message.includes("disconnected")) {
          console.debug(
            `[DataPublisher] Manifest session disconnected, retrying: ${fileHash}`,
          );
          this.#invalidateSessionCache(remoteUser);
          sessionId = null;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * 实际发送 manifest 请求并等待响应
   */
  async #sendManifestRequest(remoteUser, fileHash, sessionId) {
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    const timer = setTimeout(() => {
      this.#manifestRequestMap.delete(fileHash);
      reject(new Error(`Manifest request timed out: ${fileHash}`));
    }, MANIFEST_TIMEOUT);

    const sid = sessionId || (await this.#resolveSessionId(remoteUser));

    this.#manifestRequestMap.set(fileHash, { resolve, reject, timer, promise, unbind: () => {} });

    try {
      // 走 remoteUser.send：RTC 就绪时优先直连，否则自动 server relay
      await remoteUser.send(
        sid,
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

    await saveManifest(this.#user.namespace, fileHash, manifest);
    this.#resolveManifestRequest(fileHash, manifest);
  }

  #resolveManifestRequest(fileHash, manifest) {
    const entry = this.#manifestRequestMap.get(fileHash);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.unbind();
    this.#manifestRequestMap.delete(fileHash);
    entry.resolve(manifest);
  }

  #rejectManifestRequest(fileHash, error) {
    const entry = this.#manifestRequestMap.get(fileHash);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.unbind();
    this.#manifestRequestMap.delete(fileHash);
    entry.reject(error);
  }

  // ───── 请求方：请求 chunk ─────

  /**
   * 请求远程用户的块数据
   * 先查本地 DB，没有再发起网络请求
   * 当前 session 断开后自动重试一次。
   * @param {import("../user/remote-user.js").RemoteUser} remoteUser - 远程用户实例
   * @param {string} chunkHash - 块哈希
   * @param {string} [sessionId] - 可选，目标会话 ID，不传则自动获取第一个可用会话
   * @returns {Promise<ArrayBuffer>} 块二进制数据
   */
  async requestChunk(remoteUser, chunkHash, sessionId) {
    // 先查本地
    const local = await getChunk(this.#user.namespace, chunkHash);
    if (local) return local;

    for (let attempt = 0; attempt < 2; attempt++) {
      // 并发请求去重（每次重试重新检查，避免重复使用已失败的 Promise）
      if (attempt === 0 && this.#chunkRequestMap.has(chunkHash)) {
        return this.#chunkRequestMap.get(chunkHash);
      }

      const promise = this.#doRequestChunk(remoteUser, chunkHash, sessionId);
      this.#chunkRequestMap.set(chunkHash, promise);

      try {
        return await promise;
      } catch (err) {
        this.#chunkRequestMap.delete(chunkHash);
        if (attempt === 0 && err.message.includes("disconnected")) {
          console.debug(
            `[DataPublisher] Chunk session disconnected, retrying: ${chunkHash}`,
          );
          this.#invalidateSessionCache(remoteUser);
          sessionId = null;
          continue;
        }
        throw err;
      }
    }
  }

  /**
   * 实际发起 chunk 请求并等待响应
   *
   * 响应路径：
   * - chunk 存在：应答方发送二进制 relay，user.js 解析帧后分发到 RemoteUser，
   *   此处监听 RemoteUser 的 "message" 事件，收到二进制后 recalc hash 匹配
   * - chunk 不存在：应答方发送 JSON 错误，同样分发到 RemoteUser
   */
  async #doRequestChunk(remoteUser, chunkHash, sessionId) {
    const sid = await this.#resolveSessionId(remoteUser, sessionId);

    return new Promise((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        messageUnbind();
      };

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new Error(`Chunk request timed out: ${chunkHash}`));
      }, CHUNK_TIMEOUT);

      const messageUnbind = remoteUser.bind("message", async (event) => {
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
              cleanup();
              // 存入 DB（拷贝为独立 ArrayBuffer）
              const buffer = bytes.buffer.slice(
                bytes.byteOffset,
                bytes.byteOffset + bytes.byteLength,
              );
              await saveChunk(this.#user.namespace, recalcHash, buffer);
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
          cleanup();
          reject(new Error(data.error || "Chunk not found"));
        }
      });

      // 发送请求（走 remoteUser.send：RTC 就绪时优先直连，否则自动 server relay；raw=true 跳过 E2EE）
      remoteUser
        .send(
          sid,
          { type: "data_publish", action: "request_chunk", chunkHash },
          true,
        )
        .catch((err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          cleanup();
          reject(err);
        });
    });
  }

  // ───── 应答方：处理 incoming 请求 ─────

  /**
   * 通用响应发送：镜像请求来源的通道
   * - url != null（server relay 来源）：通过 server.relayToUserViaServer 回复
   * - url == null（RTC 来源）：通过 remoteUser.send(sid, data, true) 回复；
   *   若 RTC 仍然 open，走 DataChannel 直连（减轻服务器流量）；否则 send 内部 fallback 到 server。
   */
  async #sendResponse(fromUserId, fromSessionId, url, data) {
    if (url) {
      // server relay 来源：直接沿原服务器返回
      await this.#user.server.relayToUserViaServer(
        url,
        fromUserId,
        fromSessionId,
        data,
      );
      return;
    }

    // RTC 来源：通过 remoteUser.send 回复；raw=true 跳过 E2EE（协议内容公开）
    const remoteUser = await this.#user._ensureRemoteUser(fromUserId, "remote");
    await remoteUser.send(fromSessionId, data, true);
  }

  /**
   * 处理 incoming 的 request_manifest：查 DB，回复 manifest 或 not_found 错误
   */
  async #handleRequestManifest(fileHash, fromUserId, fromSessionId, url) {
    const manifest = await getManifest(this.#user.namespace, fileHash);
    try {
      if (manifest) {
        // 直接发送 manifest 对象
        await this.#sendResponse(fromUserId, fromSessionId, url, manifest);
      } else {
        await this.#sendResponse(fromUserId, fromSessionId, url, {
          type: "data_publish",
          action: "manifest_response",
          fileHash,
          error: "not_found",
        });
      }
    } catch (err) {
      console.warn("[DataPublisher] Failed to send manifest response:", err.message);
    }
  }

  /**
   * 处理 incoming 的 request_chunk：查 DB，回复二进制 chunk 或 not_found 错误
   */
  async #handleRequestChunk(chunkHash, fromUserId, fromSessionId, url) {
    const chunkData = await getChunk(this.#user.namespace, chunkHash);
    try {
      if (chunkData) {
        // 发送二进制 chunk 数据（server relay 自动走二进制帧；RTC 通道原样 dc.send(ArrayBuffer)）
        await this.#sendResponse(fromUserId, fromSessionId, url, chunkData);
      } else {
        await this.#sendResponse(fromUserId, fromSessionId, url, {
          type: "data_publish",
          action: "chunk_response",
          chunkHash,
          error: "not_found",
        });
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
    const manifest = await getManifest(this.#user.namespace, fileHash);
    if (!manifest) {
      throw new Error(`Manifest not found: ${fileHash}`);
    }

    const chunks = [];
    const missing = [];
    for (const chunkHash of manifest.chunkHashes) {
      const chunk = await getChunk(this.#user.namespace, chunkHash);
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

  // ───── 获取完整文件（本地优先，远程兜底） ─────

  /**
   * 获取完整文件。优先从本地 DB 读取，若缺失则自动从远程用户拉取。
   *
   * 流程：
   * 1. 尝试本地 assembleFile，若成功直接返回
   * 2. 若本地缺失数据，向远程请求 manifest
   * 3. 按 CHUNK_FETCH_CONCURRENCY 限制并发拉取缺失的 chunk
   * 4. 再次 assembleFile 返回结果
   *
   * @param {import("../user/remote-user.js").RemoteUser} remoteUser - 远程用户实例
   * @param {string} fileHash - 文件哈希
   * @param {string} [sessionId] - 可选，目标会话 ID，不传则自动获取第一个可用会话
   * @returns {Promise<{ blob: Blob, fileName: string, fileSize: number }>}
   */
  async fetchFile(remoteUser, fileHash, sessionId) {
    // 先试本地 —— 不论是 manifest 不存在还是缺少 chunk，都走远程兜底
    try {
      return await this.assembleFile(fileHash);
    } catch {
      // 忽略所有组装失败，继续尝试远程拉取
    }

    // 请求远程 manifest（会自动验签并存入本地 DB）
    await this.requestManifest(remoteUser, fileHash, sessionId);

    // 请求所有 chunk（requestChunk 内部会先查本地，不会重复拉取）
    const manifest = await getManifest(this.#user.namespace, fileHash);
    if (!manifest) {
      throw new Error(`Manifest not found after remote fetch: ${fileHash}`);
    }
    // 限制并发：避免一次性发起全部 chunk 请求灌满通道
    await asyncPool(
      manifest.chunkHashes,
      (chunkHash) => this.requestChunk(remoteUser, chunkHash, sessionId),
      CHUNK_FETCH_CONCURRENCY,
    );

    // 再次组装（此时所有 chunk 应已在本地）
    return this.assembleFile(fileHash);
  }
}
