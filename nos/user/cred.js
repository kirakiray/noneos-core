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

// 单次资料请求的等待超时（毫秒）与瞬时失败重发次数。
// 资料请求是幂等 RPC：接收端按 signTime 保留更新的资料，
// 重复请求与迟到响应均安全，故超时/发送失败可直接重发。
const PROFILE_REQ_TIMEOUT = 10000;
const PROFILE_REQ_RETRIES = 1;

// 资料交换的中继消息类型。
const PROFILE_WIRE_TYPE = "profile";

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
 *   （issuer = subject = 持有者），用户身份与公钥的载体；本类同时承载其
 *   在线交换协议（拉取 request/response + 资料变更推送 pushProfile）
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
  #requestMap = new Map(); // userId -> { resolve, reject, timer }

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

  // ───── 个人资料在线交换协议（传输） ─────

  /**
   * 启动资料交换监听
   * 自动响应 incoming 的资料请求，以及处理 incoming 的资料响应/推送
   */
  start() {
    if (this.#unbind) return;

    this.#unbind = this.#user.bind("message", (event) => {
      this.#handleRelayMessage(event.detail);
    });
  }

  /**
   * 处理 relay 消息中的资料交换协议
   * （线上 token 为 "profile"，见 PROFILE_WIRE_TYPE 说明）
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
    if (!parsed.data || parsed.data.type !== PROFILE_WIRE_TYPE) return;

    const profileMsg = parsed.data;
    const fromUserId = parsed.from_user_id;
    const fromSessionId = parsed.from_session_id;
    const viaServer = detail.url;

    if (profileMsg.action === "request") {
      await this.#handleProfileRequest(fromUserId, fromSessionId, viaServer);
    } else if (profileMsg.action === "response") {
      await this.#handleProfileResponse(profileMsg.data, fromUserId);
    }
  }

  /**
   * 处理 incoming 资料请求：回复自己的 getInfo()
   */
  async #handleProfileRequest(fromUserId, fromSessionId, viaServer) {
    this.#user._ensureRemoteUser(fromUserId, "remote").catch(() => {});

    const myInfo = await this.#user.getInfo();
    if (!myInfo) return;

    try {
      await this.#user.server.relayToUserViaServer(viaServer, fromUserId, fromSessionId, {
        type: PROFILE_WIRE_TYPE,
        action: "response",
        data: myInfo,
      });
    } catch (err) {
      console.warn("[CredentialManager] Failed to send profile response:", err.message);
    }
  }

  /**
   * 处理 incoming 资料响应/推送：验证签名后保存
   */
  async #handleProfileResponse(profileData, fromUserId) {
    this.#user._ensureRemoteUser(fromUserId, "remote").catch(() => {});

    if (!profileData || profileData.subject !== fromUserId) {
      console.warn("[CredentialManager] Profile userId mismatch");
      this.#rejectRequest(fromUserId, new Error("Profile userId mismatch"));
      return;
    }

    let saved = false;
    try {
      if (profileData.role !== PROFILE_ROLE) {
        throw new Error(`Invalid profile record (role: ${profileData.role})`);
      }
      // 统一证书导入路径（规范化验签 + signTime 竞争）
      ({ saved } = await this.importRecord(profileData));
    } catch (err) {
      console.warn("[CredentialManager] Profile verification failed:", err.message);
      this.#rejectRequest(fromUserId, err);
      return;
    }

    this.#user._trigger("profile_received", {
      userId: fromUserId,
      profile: profileData,
      saved,
    });
    this.#resolveRequest(fromUserId, profileData);
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

    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const urls = server.connectedUrls;

      for (const url of urls) {
        try {
          const result = await server.queryUserOnline(url, userId);
          if (result.online && result.sessions && result.sessions.length > 0) {
            return result.sessions[0];
          }
        } catch {
          continue;
        }
      }

      if (attempt < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }

    throw new Error(`User ${userId} is not online on any connected server`);
  }

  /**
   * 将新资料推送给所有已建立通信的远端用户（不请自来的 profile response）。
   *
   * 接收端 #handleProfileResponse 对无挂起请求的推送同样验签入库
   * （按 signTime 幂等收敛，重复/迟到推送均安全），
   * 用于用户名等资料变更的实时传播，对端无需重新拉取。
   * 静默失败（对端可能不在线），不影响本地更新流程。
   * @param {Object} profileData - 已签名的新资料数据
   */
  pushProfile(profileData) {
    for (const remote of this.#user.remoteUsers) {
      remote._notifyProfileUpdate(profileData).catch(() => {});
    }
  }

  /**
   * 从本地数据库获取个人资料（签名载荷视图，可直接整体验签）
   * @param {string} userId
   * @returns {Promise<Object | null>}
   */
  async getProfileByDB(userId) {
    const profiles = await getCertsFromDb(this.#user.namespace, {
      role: PROFILE_ROLE,
      subject: userId,
    });
    return profilePayloadView(profiles[0] ?? null);
  }

  /**
   * 获取远程用户的个人资料
   *
   * 统一入口：先查本地 DB，没有再通过网络请求获取。
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
   * 向远程用户请求个人资料（总是发起网络请求）
   *
   * 超时或发送阶段异常视为瞬时失败，自动重发一次
   * （PROFILE_REQ_RETRIES，300ms 间隔）；响应到达且签名验证通过才 resolve。
   *
   * @param {string} userId - 目标用户的 userId
   * @returns {Promise<Object>} 资料数据
   */
  async requestProfile(userId) {
    if (!userId) throw new Error("userId is required");

    if (this.#requestMap.has(userId)) {
      return this.#requestMap.get(userId).promise;
    }

    // 先把请求占位放入 #requestMap，再异步执行 connectUser/findSessionId/send，
    // 避免响应在请求发送完成前到达却找不到对应占位的情况
    let resolve, reject;
    const promise = new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });

    this.#requestMap.set(userId, {
      resolve,
      reject,
      timer: null,
      promise,
      attempts: 0,
    });

    this.#attemptProfileRequest(userId);

    return promise;
  }

  /**
   * 执行一次资料请求的发送与等待，带瞬时失败重发。
   *
   * 单次尝试：connectUser → findSessionId → 发送 profile request，
   * 并在 PROFILE_REQ_TIMEOUT 内等待响应（由 #handleProfileResponse 结算）。
   * 超时或发送异常时，若还有重试额度则 300ms 后重发，
   * 重试耗尽才 reject；响应按 userId 配对，重复请求与迟到响应均安全。
   */
  #attemptProfileRequest(userId) {
    const entry = this.#requestMap.get(userId);
    if (!entry) return;

    entry.attempts++;
    const maxAttempts = 1 + PROFILE_REQ_RETRIES;

    const fail = (err) => {
      if (entry.attempts >= maxAttempts) {
        clearTimeout(entry.timer);
        this.#requestMap.delete(userId);
        entry.reject(err);
        return;
      }
      // 瞬时失败且还有重试额度：短暂延迟后重发
      clearTimeout(entry.timer);
      entry.timer = setTimeout(() => this.#attemptProfileRequest(userId), 300);
    };

    entry.timer = setTimeout(() => {
      fail(new Error(`Profile request timed out for user ${userId}`));
    }, PROFILE_REQ_TIMEOUT);

    (async () => {
      try {
        const remoteUser = await this.#user.connectUser(userId);
        const sessionId = await this.#findSessionId(userId);
        await remoteUser.send(
          sessionId,
          { type: PROFILE_WIRE_TYPE, action: "request" },
          true,
        );
      } catch (err) {
        fail(err);
      }
    })();
  }

  #resolveRequest(userId, profileData) {
    if (this.#requestMap.has(userId)) {
      const { resolve, timer } = this.#requestMap.get(userId);
      clearTimeout(timer);
      this.#requestMap.delete(userId);
      resolve(profileData);
    }
  }

  #rejectRequest(userId, error) {
    if (this.#requestMap.has(userId)) {
      const { reject, timer } = this.#requestMap.get(userId);
      clearTimeout(timer);
      this.#requestMap.delete(userId);
      reject(error);
    }
  }
}
