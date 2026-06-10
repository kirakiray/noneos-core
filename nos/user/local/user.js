import { BaseUser } from "../base-user.js";
import { getUserKeys, saveUserKeys } from "./db.js";
import { generateKeyPair } from "../../crypto/crypto-ecdsa.js";

/**
 * 本地用户类，继承自 BaseUser
 * 根据传入的命名空间在 IndexedDB 中管理公钥和私钥
 */
export class LocalUser extends BaseUser {
  #namespace;

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
   * 重写初始化方法，从数据库获取密钥对，如果不存在则生成并保存
   * @returns {Promise}
   */
  async init() {
    let keys = await getUserKeys(this.#namespace);
    if (!keys) {
      // 数据库中没有密钥，生成新的密钥对
      keys = await generateKeyPair();
      await saveUserKeys(this.#namespace, keys);
    }

    // 调用父类的 init 以完成其余的初始化逻辑（如计算哈希、生成签名/验证函数等）
    return super.init(keys);
  }
}
