import { createSigner, createVerifier } from "../crypto/crypto-ecdsa.js";

import { getHash } from "../util/hash/get-hash.js";

/**
 * 基础用户类，处理用户身份标识、密钥对管理和签名验证
 * 继承自 EventTarget 以支持事件机制
 */
export class BaseUser extends EventTarget {
  #signer; // 签名函数
  #verifier; // 验证函数
  #userId; // 用户唯一标识 (公钥哈希)
  #_inited; // 初始化状态 Promise
  #privateKey; // 私钥
  #publicKey; // 公钥
  #unbindFns = new Set(); // 存储 bind 注册的取消函数

  /**
   * 构造函数
   * @param {string} [publicKey] - 用户公钥（可选）
   * @param {string} [privateKey] - 用户私钥（可选）
   */
  constructor(publicKey, privateKey) {
    super();
    this.#publicKey = publicKey;
    this.#privateKey = privateKey;
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
   * @param {Object} [keys] - 初始化的密钥对（可选）
   * @param {string} keys.publicKey - 公钥
   * @param {string} [keys.privateKey] - 私钥
   * @returns {Promise}
   */
  async init(keys) {
    if (this.#_inited) {
      return this.#_inited;
    }

    return (this.#_inited = (async () => {
      // 如果传入了 keys，且当前没有设置对应的 key，则进行设置
      if (keys) {
        if (!this.#publicKey && keys.publicKey) {
          this.#publicKey = keys.publicKey;
        }
        if (!this.#privateKey && keys.privateKey) {
          this.#privateKey = keys.privateKey;
        }
      }

      if (!this.#publicKey) {
        throw new Error("publicKey is required for initialization");
      }
      this.#userId = await getHash(this.#publicKey);
      this.#verifier = await createVerifier(this.#publicKey);

      // 如果存在私钥，创建签名器并验证是否与公钥匹配
      if (this.#privateKey) {
        this.#signer = await createSigner(this.#privateKey);

        // 验证公私钥是否匹配
        const testMessage = "pairing-test";
        const signature = await this.#signer(testMessage);
        const isValid = await this.#verifier(testMessage, signature);
        if (!isValid) {
          throw new Error("publicKey and privateKey do not match");
        }
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
      publicKey: this.publicKey,
    };

    // 对键进行排序以确保序列化结果的稳定性
    const sortedData = {};
    Object.keys(recordData)
      .sort()
      .forEach((key) => {
        sortedData[key] = recordData[key];
      });

    // 将对象序列化后进行签名
    const signature = await this.#signer(JSON.stringify(sortedData));

    // 将 ArrayBuffer 签名转换为 Base64 字符串
    return {
      ...sortedData,
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
        [...atob(signature)].map((c) => c.charCodeAt(0)),
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

    const unbind = () => {
      this.#unbindFns.delete(unbind);
      this.removeEventListener(eventName, callback);
    };

    this.#unbindFns.add(unbind);

    return unbind;
  }

  _trigger(eventName, detail) {
    const event = new CustomEvent(eventName, { detail });
    this.dispatchEvent(event);
  }
}
