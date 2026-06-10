import { UserDB } from "./db.js";

import {
  generateKeyPair,
  createSigner,
  createVerifier,
} from "../crypto/crypto-ecdsa.js";

import { getHash } from "../util/hash/get-hash.js";

/**
 * 基础用户类，处理用户身份标识、密钥对管理和签名验证
 * 继承自 EventTarget 以支持事件机制
 */
export class BaseUser extends EventTarget {
  #db; // 用户私有数据库
  #signer; // 签名函数
  #verifier; // 验证函数
  #publicKey; // 用户公钥 (Hex 字符串)
  #userId; // 用户唯一标识 (公钥哈希)
  #_inited; // 初始化状态 Promise

  /**
   * 构造函数
   * @param {string|object} userId - 如果是字符串则视为公钥；如果是对象或为空，则初始化数据库
   */
  constructor(userId) {
    super();
    if (typeof userId === "string") {
      this.#publicKey = userId;
    } else {
      // 如果传入的是配置对象，可以扩展，默认使用 IndexedDB 存储
      this.#db = new UserDB(`NoneOSUser_${userId || "default"}`);
    }
  }

  /**
   * 获取用户唯一 ID (公钥哈希)
   */
  get userId() {
    return this.#userId;
  }

  /**
   * 获取用户公钥
   */
  get publicKey() {
    return this.#publicKey;
  }

  /**
   * 初始化用户钥匙对
   * 1. 如果已初始化，直接返回
   * 2. 如果只有公钥，则进入只读/验证模式
   * 3. 如果有数据库，尝试从数据库加载密钥对，不存在则生成新密钥对并持久化
   * @returns {Promise}
   */
  async init() {
    if (!this.#db && !this.#publicKey) {
      throw new Error("用户数据库或公钥至少要有一个");
    }

    if (this.#_inited) {
      return this.#_inited;
    }

    return (this.#_inited = (async () => {
      if (this.#publicKey && !this.#db) {
        // 公钥模式：只能验证签名，不能生成签名
        this.#userId = await getHash(this.#publicKey);
        this.#verifier = await createVerifier(this.#publicKey);
        return;
      }

      // 初始化数据库连接
      await this.#db.init();

      // 尝试从数据库获取密钥对
      let pairData = await this.#db.get("pair");

      if (!pairData || !pairData.publicKey) {
        // 如果数据库中没有密钥对，生成新的 ECDSA 密钥对
        const pair = await generateKeyPair();
        pairData = pair;
        await this.#db.set("pair", pair);
      }

      this.#userId = await getHash(pairData.publicKey);
      this.#publicKey = pairData.publicKey;
      this.#verifier = await createVerifier(pairData.publicKey);

      // 如果存在私钥，创建签名器
      if (pairData.privateKey) {
        this.#signer = await createSigner(pairData.privateKey);
      }
    })());
  }

  /**
   * 获取签名函数
   * 如果没有私钥（公钥模式），返回 null
   */
  get sign() {
    if (!this.#signer) {
      // 公钥模式下没有私钥，无法签名
      return null;
    }

    return this._sign;
  }

  /**
   * 对数据进行签名
   * 会自动添加 signTime 和 publicKey 字段
   * @param {Object} data - 需要签名的数据对象
   * @returns {Promise<Object>} 包含原始数据、时间戳、公钥和 Base64 签名结果的对象
   */
  async _sign(data) {
    if (!this.#signer) {
      throw new Error("用户没有私钥，无法签名");
    }

    const recordData = {
      ...data,
      signTime: Date.now(),
      publicKey: this.#publicKey,
    };

    // 将对象序列化后进行签名
    const signature = await this.#signer(JSON.stringify(recordData));

    // 将 ArrayBuffer 签名转换为 Base64 字符串
    return {
      ...recordData,
      signature: btoa(String.fromCharCode(...new Uint8Array(signature))),
    };
  }

  /**
   * 验证数据签名是否正确
   * 使用自身的公钥进行验证
   * @param {Object} signedData - 包含 signature 的已签名数据对象
   * @returns {Promise<boolean>} 是否验证通过
   */
  async verify(signedData) {
    const { signature, ...data } = signedData;

    const msg = JSON.stringify(data);

    // 验证数据和签名是否存在
    if (!msg || !signature) {
      const error = new Error("Data or signature does not exist");
      console.error(error);
      return false;
    }

    try {
      // 将 Base64 签名还原为 ArrayBuffer
      const signatureBuffer = new Uint8Array(
        [...atob(signature)].map((c) => c.charCodeAt(0))
      ).buffer;

      // 执行异步验证
      const isValid = await this.#verifier(msg, signatureBuffer);

      return isValid;
    } catch (err) {
      const error = new Error("Signature format error", { cause: err });
      console.error(error);
      return false;
    }
  }

  /**
   * 绑定事件监听器
   * @param {string} eventName - 事件名称
   * @param {Function} callback - 回调函数
   * @returns {Function} 用于移除监听器的解绑函数
   */
  bind(eventName, callback) {
    this.addEventListener(eventName, callback);

    return () => {
      this.removeEventListener(eventName, callback);
    };
  }

  /**
   * 关闭用户数据库连接
   */
  close() {
    if (this.#db) {
      this.#db.close();
    }
  }
}