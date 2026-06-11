import { BaseUser } from "../base-user.js";
import {
  getUserKeys,
  saveUserKeys,
  saveCertToDb,
  getCertsFromDb,
  deleteCertFromDb,
  saveUserInfo,
  getUserInfo,
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
  #wsMap = new Map();

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
        let isNewUser = false;
        if (!keys) {
          // 数据库中没有密钥，生成新的密钥对
          keys = await generateKeyPair();
          await saveUserKeys(this.#namespace, keys);
          isNewUser = true;
        }
        return { keys, isNewUser };
      })();

      initPromises.set(this.#namespace, initPromise);

      // 初始化完成后清理缓存，允许后续重新初始化
      initPromise.finally(() => {
        initPromises.delete(this.#namespace);
      });
    }

    // 等待初始化完成并获取密钥
    const { keys, isNewUser } = await initPromise;

    // 调用父类的 init 以完成其余的初始化逻辑（如计算哈希、生成签名/验证函数等）
    await super.init(keys);

    // 如果是新用户，生成默认用户名并保存
    if (isNewUser) {
      const defaultUsername = "user-" + Math.random().toString(36).substring(2, 10);
      await this.updateInfo({ username: defaultUsername });
    }

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

  /**
   * 更新用户信息
   * 合并现有信息，签名后存储到数据库
   * @param {Object} data - 需要更新的用户信息字段
   * @returns {Promise<Object>} 更新后的签名用户信息
   */
  async updateInfo(data) {
    // 获取现有信息
    const existingInfo = await getUserInfo(this.#namespace) || {};

    // 合并数据，移除签名相关字段后重新签名
    const { signTime, publicKey, signature, ...pureExistingInfo } = existingInfo;
    const mergedData = { ...pureExistingInfo, ...data, userId: this.userId };

    // 签名数据
    const signedData = await this._sign(mergedData);

    // 保存到数据库
    await saveUserInfo(this.#namespace, signedData);

    return signedData;
  }

  /**
   * 获取用户信息
   * @returns {Promise<Object | null>} 已签名的用户信息
   */
  async getInfo() {
    return getUserInfo(this.#namespace);
  }

  /**
   * 连接握手服务器
   * @param {string} url - 握手服务器的 WebSocket 地址
   * @returns {Promise<boolean>} 连接成功返回 true
   */
  async connectServer(url) {
    if (this.#wsMap.has(url)) {
      const existingWs = this.#wsMap.get(url);
      if (existingWs.readyState === WebSocket.OPEN || existingWs.readyState === WebSocket.CONNECTING) {
        return true;
      }
      this.#wsMap.delete(url);
    }

    const userInfo = await this.getInfo();
    if (!userInfo) {
      throw new Error("User info not found");
    }

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      let isHandshaked = false;

      const timeout = setTimeout(() => {
        if (!isHandshaked) {
          ws.close();
          reject(new Error("Handshake timeout"));
        }
      }, 5000);

      ws.onopen = () => {
        ws.send(JSON.stringify(userInfo));
      };

      ws.onmessage = (event) => {
        if (!isHandshaked) {
          clearTimeout(timeout);
          try {
            const data = JSON.parse(event.data);
            if (data.type === "handshake" && data.status === "success") {
              isHandshaked = true;
              this.#wsMap.set(url, ws);
              
              // 绑定后续消息处理
              ws.onmessage = (e) => {
                const messageEvent = new CustomEvent("message", {
                  detail: {
                    url: url,
                    data: e.data,
                    originalEvent: e
                  }
                });
                this.dispatchEvent(messageEvent);
              };

              // 绑定关闭处理
              ws.onclose = () => {
                this.#wsMap.delete(url);
                const closeEvent = new CustomEvent("close", {
                  detail: { url: url }
                });
                this.dispatchEvent(closeEvent);
              };

              resolve(true);
            } else {
              const error = new Error(data.message || "Handshake failed");
              error.details = data;
              reject(error);
              ws.close();
            }
          } catch (e) {
            reject(new Error("Invalid handshake response: " + event.data));
            ws.close();
          }
        }
      };

      ws.onerror = (err) => {
        if (!isHandshaked) {
          clearTimeout(timeout);
          reject(err);
        }
      };

      ws.onclose = (event) => {
        if (!isHandshaked) {
          clearTimeout(timeout);
          reject(new Error(event.reason || "Connection closed during handshake"));
        }
      };
    });
  }

  /**
   * 向指定服务器发送数据
   * @param {string} url - 服务器地址
   * @param {string|ArrayBuffer|Blob} data - 发送的数据
   */
  sendToServer(url, data) {
    const ws = this.#wsMap.get(url);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Connection to ${url} is not open`);
    }
    ws.send(data);
  }
}
