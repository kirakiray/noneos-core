import {
  saveCertToDb,
  getCertsFromDb,
  deleteCertFromDb,
  iterateCerts,
  countCerts,
} from "./db.js";
import { createVerifier } from "../crypto/crypto-ecdsa.js";
import { getHash } from "../util/hash/get-hash.js";

export class CertManager {
  #user;

  constructor(user) {
    this.#user = user;
  }

  /**
   * 签发证书
   * @param {Object} options
   * @param {string} options.subject - 被签发人的用户ID
   * @param {string} options.role - 赋予的角色
   * @param {Object} [options.data] - 附加数据
   * @returns {Promise<Object>} 返回保存后的证书数据
   */
  async issue({ subject, role, ...data }) {
    if (!role) throw new Error("role is required");
    if (!subject) throw new Error("subject is required");

    const signedData = await this.#user._sign({
      ...data,
      role,
      issuer: this.#user.userId,
      subject,
    });

    return this.import(signedData);
  }

  /**
   * 验证并导入证书
   * @param {Object} certData - 包含签名和公钥的证书数据
   * @returns {Promise<Object>} 导入后的证书
   */
  async import(certData) {
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
    const existingCerts = await getCertsFromDb(this.#user.namespace, {
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
        await saveCertToDb(this.#user.namespace, certToSave);
        return certToSave;
      }
      // 否则保留旧证书
      return existingCert;
    }

    await saveCertToDb(this.#user.namespace, certToSave);
    return certToSave;
  }

  /**
   * 查询证书
   * @param {Object} query - { role, issuer, subject }
   * @returns {Promise<Array>}
   */
  async query(query = {}) {
    return getCertsFromDb(this.#user.namespace, query);
  }

  /**
   * 检查是否拥有某证书
   * @param {Object} query - { role, issuer, subject }
   * @returns {Promise<boolean>}
   */
  async has(query) {
    const certs = await this.query(query);
    return certs.length > 0;
  }

  /**
   * 删除证书
   * @param {string} id - 证书ID
   */
  async delete(id) {
    return deleteCertFromDb(this.#user.namespace, id);
  }

  /**
   * 获取证书数量
   * @param {Object} query - { role, issuer, subject }
   * @returns {Promise<number>}
   */
  async count(query = {}) {
    return countCerts(this.#user.namespace, query);
  }

  /**
   * 获取证书异步迭代器
   * @param {Object} query - { role, issuer, subject }
   * @returns {AsyncIterable}
   */
  values(query = {}) {
    return iterateCerts(this.#user.namespace, query);
  }
}
