/**
 * IndexedDB 封装类，用于用户数据存储
 */
export class UserDB {
  #dbName;
  #storeName;
  #db;
  #version;

  constructor(dbName = "NoneOSUserDB", storeName = "userData", version = 1) {
    this.#dbName = dbName;
    this.#storeName = storeName;
    this.#version = version;
    this.#db = null;
  }

  /**
   * 初始化数据库连接
   * @returns {Promise<IDBDatabase>}
   */
  async init() {
    if (this.#db) {
      return this.#db;
    }

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.#dbName, this.#version);

      request.onerror = () => {
        reject(new Error(`数据库打开失败: ${request.error}`));
      };

      request.onsuccess = () => {
        this.#db = request.result;
        resolve(this.#db);
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // 如果存储对象不存在，则创建
        if (!db.objectStoreNames.contains(this.#storeName)) {
          db.createObjectStore(this.#storeName, { keyPath: "key" });
        }
      };
    });
  }

  /**
   * 获取数据库实例
   * @returns {Promise<IDBDatabase>}
   */
  async getDB() {
    if (!this.#db) {
      await this.init();
    }
    return this.#db;
  }

  /**
   * 存储数据
   * @param {string} key - 数据键名
   * @param {any} value - 数据值
   * @returns {Promise<void>}
   */
  async set(key, value) {
    const db = await this.getDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.#storeName], "readwrite");
      const store = transaction.objectStore(this.#storeName);
      
      const request = store.put({ key, value });

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`数据存储失败: ${request.error}`));
      };
    });
  }

  /**
   * 获取数据
   * @param {string} key - 数据键名
   * @returns {Promise<any>}
   */
  async get(key) {
    const db = await this.getDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.#storeName], "readonly");
      const store = transaction.objectStore(this.#storeName);
      
      const request = store.get(key);

      request.onsuccess = () => {
        const result = request.result;
        resolve(result ? result.value : undefined);
      };

      request.onerror = () => {
        reject(new Error(`数据获取失败: ${request.error}`));
      };
    });
  }

  /**
   * 删除数据
   * @param {string} key - 数据键名
   * @returns {Promise<void>}
   */
  async delete(key) {
    const db = await this.getDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.#storeName], "readwrite");
      const store = transaction.objectStore(this.#storeName);
      
      const request = store.delete(key);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`数据删除失败: ${request.error}`));
      };
    });
  }

  /**
   * 检查数据是否存在
   * @param {string} key - 数据键名
   * @returns {Promise<boolean>}
   */
  async has(key) {
    const db = await this.getDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.#storeName], "readonly");
      const store = transaction.objectStore(this.#storeName);
      
      const request = store.get(key);

      request.onsuccess = () => {
        resolve(request.result !== undefined);
      };

      request.onerror = () => {
        reject(new Error(`数据检查失败: ${request.error}`));
      };
    });
  }

  /**
   * 获取所有键名
   * @returns {Promise<string[]>}
   */
  async keys() {
    const db = await this.getDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.#storeName], "readonly");
      const store = transaction.objectStore(this.#storeName);
      
      const request = store.getAllKeys();

      request.onsuccess = () => {
        resolve(request.result);
      };

      request.onerror = () => {
        reject(new Error(`获取键名列表失败: ${request.error}`));
      };
    });
  }

  /**
   * 清空所有数据
   * @returns {Promise<void>}
   */
  async clear() {
    const db = await this.getDB();
    
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([this.#storeName], "readwrite");
      const store = transaction.objectStore(this.#storeName);
      
      const request = store.clear();

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(new Error(`清空数据失败: ${request.error}`));
      };
    });
  }

  /**
   * 关闭数据库连接
   */
  close() {
    if (this.#db) {
      this.#db.close();
      this.#db = null;
    }
  }
}