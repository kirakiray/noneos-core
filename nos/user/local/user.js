import { BaseUser } from "../base-user.js";
import {
  getUserKeys,
  saveUserKeys,
  saveCertToDb,
  getCertsFromDb,
  deleteCertFromDb,
} from "../db.js";
import { generateKeyPair, createVerifier } from "../../crypto/crypto-ecdsa.js";
import { getHash } from "../../util/hash/get-hash.js";

// 全局初始化 Promise 缓存，防止同一 namespace 并发初始化
const initPromises = new Map();

/**
 * 本地用户类，继承自 BaseUser
 * 根据传入的命名空间在 IndexedDB 中管理公钥和私钥
 */
export class LocalUser extends BaseUser {
  #namespace;
  #sessionId = "s-" + Math.random().toString(36).substring(2, 10);

  /**
   * 构造函数
   * @param {string} namespace - 用户空间的命名
   */
  constructor(namespace) {
    super(); // 初始化父类，由于我们修改了 BaseUser，可以不传 publicKey
    if (!namespace) {
      throw new Error("namespace is required");
    }
    this.#namespace = namespace;
  }

  /**
   * 获取用户的命名空间
   */
  get namespace() {
    return this.#namespace;
  }

  /**
   * 准备用户实例，从数据库获取密钥对，如果不存在则生成并保存
   * 使用 Promise 缓存防止并发初始化导致密钥不一致
   * @returns {Promise}
   */
  async ready() {
    if (this.userId) {
      return this;
    }

    // 检查是否已有该 namespace 的初始化 Promise
    let initPromise = initPromises.get(this.#namespace);

    if (!initPromise) {
      // 创建新的初始化 Promise
      initPromise = (async () => {
        let keys = await getUserKeys(this.#namespace);
        if (!keys) {
          // 数据库中没有密钥，生成新的密钥对
          keys = await generateKeyPair();
          await saveUserKeys(this.#namespace, keys);
        }
        return keys;
      })();

      initPromises.set(this.#namespace, initPromise);

      // 初始化完成后清理缓存，允许后续重新初始化
      initPromise.finally(() => {
        initPromises.delete(this.#namespace);
      });
    }

    // 等待初始化完成并获取密钥
    const keys = await initPromise;

    // 调用父类的 init 以完成其余的初始化逻辑（如计算哈希、生成签名/验证函数等）
    await super.init(keys);
    return this;
  }

  /**
   * 签发证书
   * @param {Object} options
   * @param {string} options.subject - 被签发人的用户ID
   * @param {string} options.role - 赋予的角色
   * @param {Object} [options.data] - 附加数据
   * @returns {Promise<Object>} 返回保存后的证书数据
   */
  async issueCert({ subject, role, ...data }) {
    if (!role) throw new Error("role is required");
    if (!subject) throw new Error("subject is required");

    const signedData = await this._sign({
      ...data,
      role,
      issuer: this.userId,
      subject,
    });

    return this.importCert(signedData);
  }

  /**
   * 验证并导入证书
   * @param {Object} certData - 包含签名和公钥的证书数据
   * @returns {Promise<Object>} 导入后的证书
   */
  async importCert(certData) {
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

    const keyUserId = await getHash(pureCertData.publicKey);
    if (keyUserId !== pureCertData.issuer) {
      throw new Error("用户ID与公钥不匹配");
    }

    // 验证签名
    const { signature, ...data } = pureCertData;
    const msg = JSON.stringify(data);
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

    // 检查是否已存在相同 ID 的证书
    const existingCerts = await getCertsFromDb(this.#namespace, {
      role: pureCertData.role,
      issuer: pureCertData.issuer,
      subject: pureCertData.subject,
    });
    if (existingCerts.length > 0) {
      const existingCert = existingCerts[0];
      const now = Date.now();
      const newSignTime = pureCertData.signTime;
      const existingSignTime = existingCert.signTime;

      // 如果新证书时间更新且不超过当前时间，才保存新证书
      if (newSignTime > existingSignTime && newSignTime <= now) {
        await saveCertToDb(this.#namespace, certToSave);
        return certToSave;
      }
      // 否则保留旧证书
      return existingCert;
    }

    await saveCertToDb(this.#namespace, certToSave);
    return certToSave;
  }

  /**
   * 查询证书
   * @param {Object} query - { role, issuer, subject }
   * @returns {Promise<Array>}
   */
  async queryCerts(query = {}) {
    return getCertsFromDb(this.#namespace, query);
  }

  /**
   * 检查是否拥有某证书
   * @param {Object} query - { role, issuer, subject }
   * @returns {Promise<boolean>}
   */
  async hasCert(query) {
    const certs = await this.queryCerts(query);
    return certs.length > 0;
  }

  /**
   * 删除证书
   * @param {string} id - 证书ID
   */
  async deleteCert(id) {
    return deleteCertFromDb(this.#namespace, id);
  }
}
