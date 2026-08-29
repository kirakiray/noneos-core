import {
  saveCertIfNewer,
  getCertsFromDb,
  getCertsPage,
  deleteCertFromDb,
  iterateCerts,
  countCerts,
} from "./db.js";
import { createVerifier } from "../crypto/crypto-ecdsa.js";
import { getHash } from "../util/hash/get-hash.js";

// 保留角色名：个人资料（profile，旧称"名片/card"）以 role="profile" 的证书记录
// 统一存储在 certs store。该类记录必须自签（issuer === subject），自签内容不构成
// 任何授权，权限判断永远不应把 role="profile" 当作授权凭证。
export const PROFILE_ROLE = "profile";

/**
 * 读取 cred 协议层诊断日志（时间戳环形缓冲，跨同页面所有用户实例共享，
 * 同时暴露在 window.__NOS_CRED_DIAG__）。供测试在断言失败时附进输出，
 * 以便 CI（不展示 console 输出）也能看到协议层排查信息。
 * @returns {string[]}
 */
export function getCredDiagnostics() {
  return [...credDiagLog];
}

// 与 BaseUser._sign 一致的规范化序列化：按 key 字母序排序后 JSON.stringify。
// 验签方使用相同规则，消除对对象属性插入顺序的依赖，
// 记录中途经过任何序列化/重构都不会破坏验签。
function canonicalStringify(data) {
  const sorted = {};
  Object.keys(data)
    .sort()
    .forEach((key) => {
      sorted[key] = data[key];
    });
  return JSON.stringify(sorted);
}

// 个人资料在 certs store 中的记录 id，与证书 id 规则（${role}-${issuer}-${subject}）一致：
// 个人资料即 role="profile" 的自签证书（issuer = subject = 持有者自己）
const profileCertId = (userId) => `${PROFILE_ROLE}-${userId}-${userId}`;

// 从证书记录还原个人资料的签名载荷视图：剥离 DB 外层 id（id 不在签名覆盖范围内），
// 保证 profile API 读回的数据可整体验签（user.verify(record) 可直接使用）；
// 需要完整证书记录（含 id 等外层字段）时走 query
function profilePayloadView(record) {
  if (!record) return record;
  const { id, ...payload } = record;
  return payload;
}

// 凭证拉取 key 的归一化：接受 {role, issuer, subject} 对象或记录 id 字符串
// （id = `${role}-${issuer}-${subject}`，userId 为公钥哈希、不含 "-"，
// 故按前两个 "-" 拆三段即可无损还原）
function normalizeKey(keyOrId) {
  if (typeof keyOrId === "string") {
    const i1 = keyOrId.indexOf("-");
    const i2 = keyOrId.indexOf("-", i1 + 1);
    if (i1 < 0 || i2 < 0) throw new Error("无效的凭证 key");
    return {
      role: keyOrId.slice(0, i1),
      issuer: keyOrId.slice(i1 + 1, i2),
      subject: keyOrId.slice(i2 + 1),
    };
  }
  const { role, issuer, subject } = keyOrId ?? {};
  if (!role || !issuer || !subject) {
    throw new Error("凭证 key 需包含 role、issuer、subject");
  }
  return { role, issuer, subject };
}

// 单次凭证拉取请求的等待超时（毫秒）与瞬时失败重发次数。
// 拉取是幂等 RPC：接收端按 signTime 保留更新的记录，
// 重复请求与迟到响应均安全，故超时/发送失败可直接重发
// （重试额度给 2 次：高负载下中继偶发丢失/延迟时仍能收敛）。
const CRED_REQ_TIMEOUT = 10000;
const CRED_REQ_RETRIES = 2;

// 凭证拉取的中继消息类型。
const CRED_WIRE_TYPE = "cred";

// ───── 诊断日志 ─────
// CI 只展示用例的 Error/Stack，console.warn 不可见；所有 cred 协议层的
// 告警统一写入这里的时间戳环形缓冲，并在请求失败时随 Error 一并抛出。
// 同页面的多个用户实例（测试场景）共享同一份缓冲，因此请求方的失败
// 错误里也能看到对端应答侧的诊断（如"应答发送失败"）。
const CRED_DIAG_LIMIT = 60;
const credDiagLog = [];
if (typeof window !== "undefined") {
  window.__NOS_CRED_DIAG__ = credDiagLog;
}

function credDiag(message, { quiet = false } = {}) {
  const entry = `${new Date().toISOString()} ${message}`;
  credDiagLog.push(entry);
  if (credDiagLog.length > CRED_DIAG_LIMIT) credDiagLog.shift();
  if (!quiet) console.warn(`[CredentialManager] ${message}`);
}

function credDiagSnapshot(max = 15) {
  return credDiagLog.slice(-max).join("\n  ");
}

// 授权类证书的默认有效期（30 天）。expire 为绝对时间戳，随证书内容一同签名；
// 签发时显式传 null（或省略该字段）表示永不过期；profile 无过期语义（见 isCertExpired）。
const DEFAULT_CERT_LIFETIME = 30 * 24 * 60 * 60 * 1000;

// 过期判断的时钟容差：与"拒绝未来 signTime"同动机，
// 对端时钟偏快偏慢不应导致证书判生判死翻转。
const EXPIRE_TOLERANCE_MS = 5 * 60 * 1000;

// 判断证书记录当前是否已过期。profile 是长期身份数据、signTime 即版本号，
// 不参与过期；未携带 expire 字段的授权类证书视为永不过期（importRecord 会校验格式）。
function isCertExpired(cert) {
  if (cert.role === PROFILE_ROLE || cert.expire == null) return false;
  return Date.now() > cert.expire + EXPIRE_TOLERANCE_MS;
}

/**
 * 凭证管理器（CredentialManager）
 *
 * 统一管理两类签名凭证，二者共用同一存储（certs store）与同一条导入路径
 * （importRecord：规范化验签 + signTime 收敛）：
 *
 * - 个人资料（profile，旧称"名片/card"）：role="profile" 的**自签**声明
 *   （issuer = subject = 持有者），用户身份与公钥的载体；
 *   `getProfile`/`requestProfile` 是通用凭证拉取的薄封装
 * - 证书（cert）：issuer ≠ subject 的**他签**授权声明，PKI 语义
 *
 * 方法语义：
 * - `delete(id)` 删除证书记录（按记录 id）；`deleteProfile(userId)` 删除某用户的资料
 * - `count()` / `values()` 无查询条件时统计/遍历**全部**凭证记录（含个人资料）；
 *   仅操作个人资料传 `{ role: "profile" }`
 */
export class CredentialManager {
  #user;
  #unbind;
  #requestMap = new Map(); // `${fromUserId}:${role}:${issuer}:${subject}` -> { resolve, reject, timer }

  /**
   * @param {import("./user.js").LocalUser} user - 本地用户实例
   */
  constructor(user) {
    this.#user = user;
  }

  // ───── 签发与导入（统一路径） ─────

  /**
   * 签发证书
   * @param {Object} options
   * @param {string} options.subject - 被签发人的用户ID
   * @param {string} options.role - 赋予的角色
   * @param {number|null} [options.expire] - 过期时间戳；不传默认签发后 30 天，
   *   传 null 表示永不过期；expire 会进入签名载荷，被签名保护
   * @param {Object} [options.data] - 附加数据
   * @returns {Promise<Object>} 返回保存后的证书数据
   */
  async issue({ subject, role, expire = Date.now() + DEFAULT_CERT_LIFETIME, ...data }) {
    if (!role) throw new Error("role is required");
    if (!subject) throw new Error("subject is required");

    const payload = {
      ...data,
      role,
      issuer: this.#user.userId,
      subject,
    };
    if (expire !== null) {
      if (typeof expire !== "number" || !Number.isFinite(expire)) {
        throw new Error("expire 必须为有效时间戳或 null");
      }
      payload.expire = expire;
    }

    const signedData = await this.#user._sign(payload);

    return this.import(signedData);
  }

  /**
   * 验证并导入证书
   * @param {Object} certData - 包含签名和公钥的证书数据
   * @returns {Promise<Object>} 导入后的证书
   */
  async import(certData) {
    const { cert } = await this.importRecord(certData);
    return cert;
  }

  /**
   * 验证并导入证书，并返回是否实际写入
   * @param {Object} certData - 包含签名和公钥的证书数据
   * @returns {Promise<{cert: Object, saved: boolean}>}
   *   cert 为最终保留的记录（可能是已存在的更旧/更新记录），saved 表示本次是否写入
   */
  async importRecord(certData) {
    // 移除外部传入时可能带有的 id，确保验证的数据只包含原始签名字段
    const { id: _certId, ...pureCertData } = certData;

    const requiredKeys = [
      "role",
      "issuer",
      "subject",
      "publicKey",
      "signTime",
      "signature",
    ];

    for (const key of requiredKeys) {
      if (!(key in pureCertData)) {
        throw new Error(`缺少必要字段: ${key}`);
      }
    }

    // 个人资料是自签声明：只允许 issuer === subject，防止伪造他人资料记录
    if (
      pureCertData.role === PROFILE_ROLE &&
      pureCertData.issuer !== pureCertData.subject
    ) {
      throw new Error('role="profile" 为保留角色，仅允许自签名（issuer 必须等于 subject）');
    }

    // 授权类证书的过期校验（profile 例外）：expire 需为晚于 signTime 的有效时间戳，
    // 且尚未过期（含时钟容差）；"永不过期"的证书不携带该字段
    if (pureCertData.role !== PROFILE_ROLE) {
      const { expire, signTime } = pureCertData;
      if (expire !== undefined) {
        if (typeof expire !== "number" || !Number.isFinite(expire)) {
          throw new Error("expire 必须为有效时间戳（永不过期请省略该字段）");
        }
        if (expire <= signTime) {
          throw new Error("expire 必须晚于 signTime");
        }
        if (isCertExpired(pureCertData)) {
          throw new Error("证书已过期");
        }
      }
    }

    const keyUserId = await getHash(pureCertData.publicKey);
    if (keyUserId !== pureCertData.issuer) {
      throw new Error("用户ID与公钥不匹配");
    }

    // 验证签名（规范化排序序列化，与 _sign 的签名规则一致）
    const { signature, ...data } = pureCertData;
    const msg = canonicalStringify(data);
    const verifier = await createVerifier(pureCertData.publicKey);

    try {
      const signatureBuffer = new Uint8Array(
        [...atob(signature)].map((c) => c.charCodeAt(0)),
      ).buffer;
      const isValid = await verifier(msg, signatureBuffer);
      if (!isValid) throw new Error("证书签名验证失败");
    } catch (err) {
      if (err.message === "证书签名验证失败") throw err;
      throw new Error("证书格式错误", { cause: err });
    }

    // 生成唯一ID
    const id = `${pureCertData.role}-${pureCertData.issuer}-${pureCertData.subject}`;
    const certToSave = { id, ...pureCertData };

    // 个人资料的 signTime 只是版本号（单调递增即可），不校验未来时间：
    // 对端时钟偏快时若拒绝未来签名，本地将永远停留在旧资料。
    // 授权类证书维持"拒绝未来时间"的既有约束。
    const allowFuture = pureCertData.role === PROFILE_ROLE;

    return this.saveIfNewer(certToSave, { allowFuture });
  }

  /**
   * 按同 id 记录做 signTime 竞争后写入（不验签，供已通过验证的记录复用，
   * 如批量同步场景）；importRecord 的收敛核心
   * @param {Object} certToSave - 含 id 的完整证书记录
   * @param {Object} [options]
   * @param {boolean} [options.allowFuture] - 允许 signTime 超过当前时间（资料语义）
   * @returns {Promise<{cert: Object, saved: boolean}>}
   */
  async saveIfNewer(certToSave, { allowFuture = false } = {}) {
    // 已过期的记录不参与竞争写入（importRecord 已拒绝导入，此处为直接调用兜底）
    if (isCertExpired(certToSave)) {
      return { cert: certToSave, saved: false };
    }

    const existingCerts = await getCertsFromDb(this.#user.namespace, {
      role: certToSave.role,
      issuer: certToSave.issuer,
      subject: certToSave.subject,
    });
    if (existingCerts.length > 0) {
      const existingCert = existingCerts[0];
      const newSignTime = certToSave.signTime;
      const existingSignTime = existingCert.signTime;
      const newer = allowFuture
        ? newSignTime > existingSignTime
        : newSignTime > existingSignTime && newSignTime <= Date.now();
      if (!newer) {
        return { cert: existingCert, saved: false };
      }
    }
    return saveCertIfNewer(this.#user.namespace, certToSave);
  }

  // ───── 查询 ─────

  /**
   * 查询凭证（含个人资料记录）
   * @param {Object} query - { role, issuer, subject }
   * @param {Object} [options]
   * @param {boolean} [options.includeExpired] - 包含已过期记录（默认过滤）
   * @param {number} [options.limit] - 单页条数；传入即启用 keyset 分页，
   *   返回 { items, nextCursor, hasMore }（nextCursor 传回 after 续读下一页），
   *   不传则一次性返回全部匹配记录的数组
   * @param {[key, primaryKey]} [options.after] - 续读游标（上一页返回的 nextCursor）
   * @returns {Promise<Array | {items: Array, nextCursor: Array | null, hasMore: boolean}>}
   */
  async query(query = {}, { includeExpired = false, limit, after } = {}) {
    if (limit == null) {
      const certs = await getCertsFromDb(this.#user.namespace, query);
      return includeExpired ? certs : certs.filter((cert) => !isCertExpired(cert));
    }

    // 分页路径：过期过滤下沉到游标循环，被滤记录不占 limit 额度
    return getCertsPage(this.#user.namespace, query, {
      limit,
      after,
      filter: includeExpired ? null : (cert) => !isCertExpired(cert),
    });
  }

  /**
   * 检查是否拥有某凭证（默认不含已过期记录）
   * @param {Object} query - { role, issuer, subject }
   * @returns {Promise<boolean>}
   */
  async has(query) {
    const certs = await this.query(query);
    return certs.length > 0;
  }

  /**
   * 删除证书记录
   * @param {string} id - 记录 id（`${role}-${issuer}-${subject}`）；
   *   删除某用户的个人资料请用 deleteProfile(userId)
   */
  async delete(id) {
    if (!id) throw new Error("id is required");
    return deleteCertFromDb(this.#user.namespace, id);
  }

  /**
   * 删除某用户的个人资料记录
   * @param {string} userId
   */
  async deleteProfile(userId) {
    if (!userId) throw new Error("userId is required");
    return deleteCertFromDb(this.#user.namespace, profileCertId(userId));
  }

  /**
   * 统计凭证数量；无查询条件时为全部记录（含个人资料，默认不含已过期）
   * @param {Object} query - { role, issuer, subject }；仅个人资料传 { role: "profile" }
   * @param {Object} [options]
   * @param {boolean} [options.includeExpired] - 统计包含已过期记录（默认过滤）
   * @returns {Promise<number>}
   */
  async count(query = {}, { includeExpired = false } = {}) {
    if (includeExpired) {
      return countCerts(this.#user.namespace, query);
    }
    const certs = await this.query(query);
    return certs.length;
  }

  /**
   * 获取凭证异步迭代器（DB 完整记录，含 id 外层字段）；
   * 无查询条件时遍历全部记录（含个人资料，默认不含已过期）
   * @param {Object} query - { role, issuer, subject }
   * @param {Object} [options]
   * @param {boolean} [options.includeExpired] - 遍历包含已过期记录（默认过滤）
   * @returns {AsyncIterable}
   */
  async *values(query = {}, { includeExpired = false } = {}) {
    for await (const cert of iterateCerts(this.#user.namespace, query)) {
      if (includeExpired || !isCertExpired(cert)) {
        yield cert;
      }
    }
  }

  // ───── 凭证按 key 拉取协议（传输） ─────

  /**
   * 启动凭证拉取监听
   * 自动响应 incoming 的凭证拉取请求，以及处理 incoming 的拉取响应
   */
  start() {
    if (this.#unbind) return;

    this.#unbind = this.#user.bind("message", (event) => {
      this.#handleRelayMessage(event.detail);
    });
  }

  /**
   * 处理 relay 消息中的凭证拉取协议
   * （线上 token 为 "cred"，见 CRED_WIRE_TYPE 说明）
   */
  async #handleRelayMessage(detail) {
    let rawData;
    try {
      rawData =
        typeof detail.data === "string"
          ? detail.data
          : new TextDecoder().decode(detail.data);
    } catch {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }

    if (parsed.type !== "relay") return;
    if (!parsed.data || parsed.data.type !== CRED_WIRE_TYPE) return;

    const credMsg = parsed.data;
    const fromUserId = parsed.from_user_id;
    const fromSessionId = parsed.from_session_id;
    const viaServer = detail.url;

    if (credMsg.action === "request") {
      if (!fromUserId || !fromSessionId) {
        credDiag(
          `Cred request missing fromUserId/fromSessionId, cannot reply: ${JSON.stringify({ fromUserId, fromSessionId, viaServer })}`,
        );
        return;
      }
      await this.#handleCredRequest(
        fromUserId,
        fromSessionId,
        viaServer,
        credMsg.key,
      );
    } else if (credMsg.action === "response") {
      await this.#handleCredResponse(credMsg.key, credMsg.data, fromUserId);
    } else {
      credDiag(`Unknown cred action "${credMsg.action}" from ${fromUserId}`);
    }
  }

  /**
   * 处理 incoming 拉取请求：按精确 key 查本地记录并回复
   *
   * 应答规则：不限定签发/被签发关系——本地持有的任意精确匹配 key 的记录均可应答
   * （含他人签发给第三方的证书，支持本地应用托管此类记录）。
   * 安全边界：请求方必须已知精确 key（无法枚举），且收到记录仍走 importRecord 验签。
   */
  async #handleCredRequest(fromUserId, fromSessionId, viaServer, key) {
    this.#user._ensureRemoteUser(fromUserId, "remote").catch(() => {});

    let data = null;
    try {
      const normalized = normalizeKey(key);

      // 本地用户自己的资料存于 data store（saveUserInfo，key "info"），
      // 不在 certs store，命中本地 profile key 时从 getInfo() 应答
      if (
        normalized.role === PROFILE_ROLE &&
        normalized.issuer === this.#user.userId &&
        normalized.subject === this.#user.userId
      ) {
        data = await this.#user.getInfo();
      } else {
        const records = await getCertsFromDb(this.#user.namespace, normalized);
        data = records[0] ?? null;
      }
    } catch (err) {
      credDiag(
        `Invalid cred request key from ${fromUserId}: ${err.message}`,
      );
    }

    try {
      await this.#user.server.relayToUserViaServer(viaServer, fromUserId, fromSessionId, {
        type: CRED_WIRE_TYPE,
        action: "response",
        key,
        data,
      });
    } catch (err) {
      credDiag(
        `Failed to send cred response to ${fromUserId} (session ${fromSessionId} via ${viaServer}): ${err.message}`,
      );
    }
  }

  /**
   * 处理 incoming 拉取响应：校验记录与请求 key 一致后统一导入（结算对应的挂起请求）
   */
  async #handleCredResponse(key, data, fromUserId) {
    this.#user._ensureRemoteUser(fromUserId, "remote").catch(() => {});

    let normalized;
    try {
      normalized = normalizeKey(key);
    } catch {
      return;
    }

    // 未命中：响应方没有该 key 的记录，直接结算挂起请求
    if (!data) {
      this.#resolveRequest(fromUserId, normalized, null);
      return;
    }

    const matchesKey =
      data.role === normalized.role &&
      data.issuer === normalized.issuer &&
      data.subject === normalized.subject;
    if (!matchesKey) {
      credDiag(`Cred record key mismatch in response from ${fromUserId}`);
      this.#rejectRequest(fromUserId, normalized, new Error("Cred record key mismatch"));
      return;
    }

    // profile 是持有者的自签声明：必须由持有者本人提供
    if (data.role === PROFILE_ROLE && data.subject !== fromUserId) {
      credDiag(`Profile userId mismatch in response from ${fromUserId}`);
      this.#rejectRequest(fromUserId, normalized, new Error("Profile userId mismatch"));
      return;
    }

    let saved = false;
    try {
      // 统一证书导入路径（规范化验签 + signTime 竞争）
      ({ saved } = await this.importRecord(data));
    } catch (err) {
      credDiag(`Cred verification failed for record from ${fromUserId}: ${err.message}`);
      this.#rejectRequest(fromUserId, normalized, err);
      return;
    }

    if (data.role === PROFILE_ROLE) {
      this.#user._trigger("profile_received", {
        userId: fromUserId,
        profile: data,
        saved,
      });
    } else {
      this.#user._trigger("cert_received", {
        cert: data,
        saved,
        fromUserId,
      });
    }
    this.#resolveRequest(fromUserId, normalized, profilePayloadView(data));
  }

  /**
   * 自动查找远程用户的在线 sessionId
   *
   * 因并发握手/状态同步可能存在短暂窗口，
   * 这里复用 connectUser 的策略做少量重试，避免瞬时查询失败。
   */
  async #findSessionId(userId) {
    const server = this.#user.server;
    const maxRetries = 5;
    const failures = [];

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const urls = server.connectedUrls;

      if (urls.length === 0) {
        failures.push(`attempt ${attempt + 1}: no connected server`);
      }

      for (const url of urls) {
        try {
          const result = await server.queryUserOnline(url, userId);
          if (result.online && result.sessions && result.sessions.length > 0) {
            return result.sessions[0];
          }
          failures.push(
            `attempt ${attempt + 1}: ${url} online=${result.online} sessions=${result.sessions?.length ?? 0}`,
          );
        } catch (err) {
          failures.push(`attempt ${attempt + 1}: ${url} error: ${err.message}`);
          continue;
        }
      }

      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    credDiag(
      `findSessionId exhausted ${maxRetries} retries for user ${userId}: ${failures.join(" | ")}`,
    );
    throw new Error(
      `User ${userId} is not online on any connected server (${failures.join(" | ")})`,
    );
  }

  /**
   * 从本地数据库按 key 获取凭证记录（签名载荷视图，可直接整体验签）
   * @param {string|Object} keyOrId - {role, issuer, subject} 或记录 id 字符串
   * @returns {Promise<Object | null>}
   */
  async getRecordByDB(keyOrId) {
    const records = await getCertsFromDb(this.#user.namespace, normalizeKey(keyOrId));
    return profilePayloadView(records[0] ?? null);
  }

  /**
   * 按需获取凭证记录：先查本地 DB，没有再向指定用户发起网络拉取
   * @param {string} fromUserId - 向哪个用户拉取（key 不含"该问谁"的信息，需显式指定）
   * @param {string|Object} keyOrId - {role, issuer, subject} 或记录 id 字符串
   * @returns {Promise<Object | null>} 记录（签名载荷视图）或 null（未命中）
   */
  async getRecord(fromUserId, keyOrId) {
    if (!fromUserId) throw new Error("fromUserId is required");
    const key = normalizeKey(keyOrId);

    const existing = await this.getRecordByDB(key);
    if (existing) return existing;

    return this.requestRecord(fromUserId, key);
  }

  /**
   * 向远程用户按 key 拉取凭证记录（总是发起网络请求）
   *
   * 超时或发送阶段异常视为瞬时失败，自动重发
   * （最多 CRED_REQ_RETRIES 次，300ms 间隔）；响应到达且签名验证通过才 resolve，
   * 响应方无该记录时 resolve(null)。
   *
   * @param {string} fromUserId - 目标用户的 userId
   * @param {string|Object} keyOrId - {role, issuer, subject} 或记录 id 字符串
   * @returns {Promise<Object | null>} 记录（签名载荷视图）或 null（未命中）
   */
  async requestRecord(fromUserId, keyOrId) {
    if (!fromUserId) throw new Error("fromUserId is required");
    const key = normalizeKey(keyOrId);
    const mapKey = this.#requestKey(fromUserId, key);

    if (this.#requestMap.has(mapKey)) {
      return this.#requestMap.get(mapKey).promise;
    }

    // 先把请求占位放入 #requestMap，再异步执行 connectUser/findSessionId/send，
    // 避免响应在请求发送完成前到达却找不到对应占位的情况
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.#requestMap.set(mapKey, {
      resolve,
      reject,
      timer: null,
      promise,
      attempts: 0,
      startTime: Date.now(),
      errors: [],
    });

    this.#attemptCredRequest(fromUserId, key, mapKey);

    return promise;
  }

  /**
   * 执行一次凭证拉取的发送与等待，带瞬时失败重发。
   *
   * 单次尝试：connectUser → findSessionId → 通过服务器中转发送 cred request，
   * 并在 CRED_REQ_TIMEOUT 内等待响应（由 #handleCredResponse 结算）。
   * 超时或发送异常时，若还有重试额度则 300ms 后重发，
   * 重试耗尽才 reject；响应按 fromUserId+key 配对，重复请求与迟到响应均安全。
   *
   * 注意：cred 协议必须强制走服务器中转（server.sendToUser），
   * 不能使用 remoteUser.send()——后者在 RTC 通道就绪后会静默改走
   * DataChannel，而对端 cred 处理器只监听服务器 relay 消息，
   * 经 RTC 到达的请求将无人应答直至超时。
   */
  #attemptCredRequest(fromUserId, key, mapKey) {
    const entry = this.#requestMap.get(mapKey);
    if (!entry) return;

    entry.attempts++;
    const attempt = entry.attempts;
    const maxAttempts = 1 + CRED_REQ_RETRIES;
    const keyDesc = `${key.role}/${key.issuer}/${key.subject}`;

    const fail = (stage, err) => {
      const detail = `${stage}: ${err?.message || err}`;
      entry.errors.push(`attempt ${attempt}/${maxAttempts} ${detail}`);
      credDiag(
        `Cred request attempt ${attempt}/${maxAttempts} failed for user ${fromUserId} (key=${keyDesc}) — ${detail}`,
      );

      if (entry.attempts >= maxAttempts) {
        clearTimeout(entry.timer);
        this.#requestMap.delete(mapKey);
        // CI 只展示 Error/Stack：把 cred 协议层最近的诊断（含对端应答侧，
        // 同页面共享缓冲）随错误一并抛出，便于离线定位
        entry.reject(
          new Error(
            `Cred request failed for user ${fromUserId} (key=${keyDesc}, ` +
              `${Date.now() - entry.startTime}ms total). Attempts: ${entry.errors.join(" | ")}` +
              `\n--- recent cred diagnostics ---\n  ${credDiagSnapshot()}`,
            { cause: err },
          ),
        );
        return;
      }
      // 瞬时失败且还有重试额度：短暂延迟后重发
      clearTimeout(entry.timer);
      entry.timer = setTimeout(
        () => this.#attemptCredRequest(fromUserId, key, mapKey),
        300,
      );
    };

    entry.timer = setTimeout(() => {
      fail(
        "timeout",
        new Error(
          `no cred response within ${CRED_REQ_TIMEOUT}ms (request sent via server relay)`,
        ),
      );
    }, CRED_REQ_TIMEOUT);

    (async () => {
      try {
        const remoteUser = await this.#user.connectUser(fromUserId);
        const sessionId = await this.#findSessionId(fromUserId);
        // 强制服务器中转，见方法注释；此处等价于 remoteUser.send 的
        // server 路径（raw 跳过加密），但不允许其回落到 RTC
        const result = await this.#user.server.sendToUser(
          fromUserId,
          sessionId,
          { type: CRED_WIRE_TYPE, action: "request", key },
        );
        credDiag(
          `Cred request sent to user ${fromUserId} via server ${result?.url} (session ${sessionId}, attempt ${attempt}/${maxAttempts}, key=${keyDesc})`,
          { quiet: true },
        );
      } catch (err) {
        fail("send", err);
      }
    })();
  }

  #requestKey(fromUserId, key) {
    return `${fromUserId}:${key.role}:${key.issuer}:${key.subject}`;
  }

  #resolveRequest(fromUserId, key, record) {
    const mapKey = this.#requestKey(fromUserId, key);
    if (this.#requestMap.has(mapKey)) {
      const { resolve, timer } = this.#requestMap.get(mapKey);
      clearTimeout(timer);
      this.#requestMap.delete(mapKey);
      resolve(record);
    }
  }

  #rejectRequest(fromUserId, key, error) {
    const mapKey = this.#requestKey(fromUserId, key);
    if (this.#requestMap.has(mapKey)) {
      const { reject, timer } = this.#requestMap.get(mapKey);
      clearTimeout(timer);
      this.#requestMap.delete(mapKey);
      reject(error);
    }
  }

  // ───── 个人资料便捷封装（薄封装，语义同通用拉取） ─────

  /**
   * 从本地数据库获取个人资料（签名载荷视图，可直接整体验签）
   * @param {string} userId
   * @returns {Promise<Object | null>}
   */
  async getProfileByDB(userId) {
    if (!userId) throw new Error("userId is required");
    return this.getRecordByDB({
      role: PROFILE_ROLE,
      issuer: userId,
      subject: userId,
    });
  }

  /**
   * 获取远程用户的个人资料
   *
   * 统一入口：先查本地 DB，没有再向持有者本人拉取。
   *
   * @param {string} userId - 目标用户的 userId
   * @returns {Promise<Object>} 资料数据
   */
  async getProfile(userId) {
    if (!userId) throw new Error("userId is required");

    const existing = await this.getProfileByDB(userId);
    if (existing) return existing;

    return this.requestProfile(userId);
  }

  /**
   * 向资料持有者拉取个人资料（总是发起网络请求）
   * @param {string} userId - 目标用户的 userId
   * @returns {Promise<Object>} 资料数据
   */
  async requestProfile(userId) {
    if (!userId) throw new Error("userId is required");
    return this.requestRecord(userId, {
      role: PROFILE_ROLE,
      issuer: userId,
      subject: userId,
    });
  }
}
