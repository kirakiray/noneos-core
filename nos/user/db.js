const STORE_NAME = "data";
const CERT_STORE_NAME = "certs";
const CARD_STORE_NAME = "cards";
const TRAFFIC_ENTRIES_STORE = "traffic_entries";
const TRAFFIC_AGG_MINUTE_STORE = "traffic_agg_minute";
const DB_VERSION = 7;

// 数据库连接缓存池
// 缓存的是 Promise 而非连接本身：并发的 getDb 复用同一次 indexedDB.open，
// 避免产生脱离缓存的"孤儿连接"（dbCache.set 被后者覆盖后无法被
// closeDbByNamespace 关闭，会让 indexedDB.deleteDatabase 一直被 block）。
const dbCache = new Map(); // dbName -> Promise<IDBDatabase>
const dbTimers = new Map(); // dbName -> 自动关闭 timer
const CACHE_TIMEOUT = 5000; // 5秒

/**
 * 刷新连接的自动关闭计时
 * @param {string} dbName
 */
function refreshDbTimer(dbName) {
  clearTimeout(dbTimers.get(dbName));
  dbTimers.set(dbName, setTimeout(() => closeDbCache(dbName), CACHE_TIMEOUT));
}

/**
 * 获取数据库实例（带缓存池）
 * @param {string} namespace
 * @returns {Promise<IDBDatabase>}
 */
function getDb(namespace) {
  const dbName = `nos_user_${namespace}`;

  // 检查缓存（含打开中的 Promise，并发调用复用同一次 open）
  const cached = dbCache.get(dbName);
  if (cached) {
    return cached.then((db) => {
      // 连接仍在使用，刷新自动关闭计时
      if (dbCache.has(dbName)) {
        refreshDbTimer(dbName);
      }
      return db;
    });
  }

  const promise = new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);

    request.onerror = () => {
      // 打开失败：清理缓存，允许后续重试
      if (dbCache.get(dbName) === promise) {
        dbCache.delete(dbName);
      }
      reject(request.error);
    };

    request.onsuccess = () => {
      const db = request.result;
      if (dbCache.get(dbName) !== promise) {
        // 打开期间缓存已被 closeDbByNamespace 清除（deleteUser 清理流程），
        // 立即关闭这个新连接，避免阻塞随后发起的 deleteDatabase
        db.close();
        reject(new Error(`Database "${dbName}" was closed during open`));
        return;
      }
      // 收到版本变更请求（如 deleteDatabase）时自动关闭连接，
      // 避免删除操作被 onblocked 长时间阻塞
      db.onversionchange = () => closeDbCache(dbName);
      refreshDbTimer(dbName);
      resolve(db);
    };

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(CERT_STORE_NAME)) {
        const certStore = db.createObjectStore(CERT_STORE_NAME, { keyPath: "id" });
        // 单字段索引
        certStore.createIndex("role", "role", { unique: false });
        certStore.createIndex("issuer", "issuer", { unique: false });
        certStore.createIndex("subject", "subject", { unique: false });
        // 复合索引
        certStore.createIndex("role_issuer", ["role", "issuer"], { unique: false });
        certStore.createIndex("role_subject", ["role", "subject"], { unique: false });
        certStore.createIndex("issuer_subject", ["issuer", "subject"], { unique: false });
        certStore.createIndex("role_issuer_subject", ["role", "issuer", "subject"], { unique: false });
      }
      if (!db.objectStoreNames.contains(CARD_STORE_NAME)) {
        db.createObjectStore(CARD_STORE_NAME, { keyPath: "userId" });
      }
      if (!db.objectStoreNames.contains(TRAFFIC_ENTRIES_STORE)) {
        const trafficStore = db.createObjectStore(TRAFFIC_ENTRIES_STORE, {
          keyPath: "id",
          autoIncrement: true,
        });
        // 单字段索引
        trafficStore.createIndex("ts", "ts", { unique: false });
        // 复合索引：便于按维度 + 时间范围查询
        trafficStore.createIndex("peer_ts", ["peerUserId", "ts"], { unique: false });
        trafficStore.createIndex("via_ts", ["via", "ts"], { unique: false });
        trafficStore.createIndex("dir_ts", ["direction", "ts"], { unique: false });
        trafficStore.createIndex("cat_ts", ["category", "ts"], { unique: false });
        trafficStore.createIndex("app_ts", ["appId", "ts"], { unique: false });
        trafficStore.createIndex("server_ts", ["serverUrl", "ts"], { unique: false });
      }
      if (!db.objectStoreNames.contains(TRAFFIC_AGG_MINUTE_STORE)) {
        const aggStore = db.createObjectStore(TRAFFIC_AGG_MINUTE_STORE, {
          keyPath: "id",
        });
        aggStore.createIndex("bucket", "bucket", { unique: false });
        aggStore.createIndex("peer_bucket", ["peerUserId", "bucket"], { unique: false });
        aggStore.createIndex("via_bucket", ["via", "bucket"], { unique: false });
        aggStore.createIndex("server_bucket", ["serverUrl", "bucket"], { unique: false });
        aggStore.createIndex("cat_bucket", ["category", "bucket"], { unique: false });
      }
    };
  });

  dbCache.set(dbName, promise);
  return promise;
}

/**
 * 获取共享的数据库实例（供 traffic.js 等模块复用）
 * @param {string} namespace
 * @returns {Promise<IDBDatabase>}
 */
export function getSharedDb(namespace) {
  if (!namespace) throw new Error("namespace is required");
  return getDb(namespace);
}

export const TRAFFIC_STORES = {
  entries: TRAFFIC_ENTRIES_STORE,
  aggMinute: TRAFFIC_AGG_MINUTE_STORE,
};

/**
 * 关闭并清理缓存中的数据库连接
 * 支持清理打开中的 Promise：缓存项被移除后，在途的 open 完成时会自行关闭连接
 * @param {string} dbName
 */
function closeDbCache(dbName) {
  const cached = dbCache.get(dbName);
  if (!cached) return;
  dbCache.delete(dbName);
  clearTimeout(dbTimers.get(dbName));
  dbTimers.delete(dbName);
  cached.then(
    (db) => {
      try {
        db.close();
      } catch {
        // 连接可能已关闭
      }
    },
    () => {
      // 打开失败或在途期间被清除，无需处理
    },
  );
}

/**
 * 根据 namespace 关闭并清理缓存中的数据库连接
 * @param {string} namespace
 */
export function closeDbByNamespace(namespace) {
  const dbName = `nos_user_${namespace}`;
  closeDbCache(dbName);
}

/**
 * 存储用户密钥对
 * @param {string} namespace
 * @param {Object} keys - { publicKey, privateKey }
 */
export async function saveUserKeys(namespace, keys) {
  if (!namespace) {
    throw new Error("namespace is required");
  }
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(keys, "keys");

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 获取用户密钥对
 * @param {string} namespace
 * @returns {Promise<{publicKey: string, privateKey: string} | null>}
 */
export async function getUserKeys(namespace) {
  if (!namespace) {
    throw new Error("namespace is required");
  }
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get("keys");

    request.onsuccess = (event) => {
      resolve(event.target.result || null);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * 保存证书
 * @param {string} namespace
 * @param {Object} certData
 */
export async function saveCertToDb(namespace, certData) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CERT_STORE_NAME], "readwrite");
    const store = transaction.objectStore(CERT_STORE_NAME);
    const request = store.put(certData);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 查询证书
 * @param {string} namespace
 * @param {Object} query - 查询条件 { role, issuer, subject }
 * @returns {Promise<Array>}
 */
export async function getCertsFromDb(namespace, query = {}) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  
  const { role, issuer, subject } = query;
  const hasRole = role !== undefined;
  const hasIssuer = issuer !== undefined;
  const hasSubject = subject !== undefined;
  
  // 确定使用哪个索引
  let indexName = null;
  let indexKey = null;
  
  if (hasRole && hasIssuer && hasSubject) {
    indexName = "role_issuer_subject";
    indexKey = [role, issuer, subject];
  } else if (hasRole && hasIssuer) {
    indexName = "role_issuer";
    indexKey = [role, issuer];
  } else if (hasRole && hasSubject) {
    indexName = "role_subject";
    indexKey = [role, subject];
  } else if (hasIssuer && hasSubject) {
    indexName = "issuer_subject";
    indexKey = [issuer, subject];
  } else if (hasRole) {
    indexName = "role";
    indexKey = role;
  } else if (hasIssuer) {
    indexName = "issuer";
    indexKey = issuer;
  } else if (hasSubject) {
    indexName = "subject";
    indexKey = subject;
  }
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CERT_STORE_NAME], "readonly");
    const store = transaction.objectStore(CERT_STORE_NAME);
    
    let request;
    if (indexName) {
      const index = store.index(indexName);
      request = index.getAll(indexKey);
    } else {
      // 无查询条件，返回全部
      request = store.getAll();
    }
    
    request.onsuccess = (event) => {
      resolve(event.target.result || []);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * 删除证书
 * @param {string} namespace
 * @param {string} certId
 */
export async function deleteCertFromDb(namespace, certId) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CERT_STORE_NAME], "readwrite");
    const store = transaction.objectStore(CERT_STORE_NAME);
    const request = store.delete(certId);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 使用游标遍历证书
 * @param {string} namespace
 * @param {Object} query - 查询条件 { role, issuer, subject }
 * @returns {AsyncIterable}
 */
export function iterateCerts(namespace, query = {}) {
  if (!namespace) throw new Error("namespace is required");
  
  return {
    [Symbol.asyncIterator]() {
      let db = null;
      let request = null;
      
      return {
        async next() {
          if (!db) {
            db = await getDb(namespace);
            const transaction = db.transaction([CERT_STORE_NAME], "readonly");
            const store = transaction.objectStore(CERT_STORE_NAME);
            
            const { role, issuer, subject } = query;
            const hasRole = role !== undefined;
            const hasIssuer = issuer !== undefined;
            const hasSubject = subject !== undefined;
            
            // 确定使用哪个索引
            let indexName = null;
            let indexKey = null;
            
            if (hasRole && hasIssuer && hasSubject) {
              indexName = "role_issuer_subject";
              indexKey = [role, issuer, subject];
            } else if (hasRole && hasIssuer) {
              indexName = "role_issuer";
              indexKey = [role, issuer];
            } else if (hasRole && hasSubject) {
              indexName = "role_subject";
              indexKey = [role, subject];
            } else if (hasIssuer && hasSubject) {
              indexName = "issuer_subject";
              indexKey = [issuer, subject];
            } else if (hasRole) {
              indexName = "role";
              indexKey = role;
            } else if (hasIssuer) {
              indexName = "issuer";
              indexKey = issuer;
            } else if (hasSubject) {
              indexName = "subject";
              indexKey = subject;
            }
            
            if (indexName) {
              const index = store.index(indexName);
              request = index.openCursor(indexKey);
            } else {
              request = store.openCursor();
            }
          }
          
          return new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
              const cursor = event.target.result;
              
              if (cursor) {
                const value = cursor.value;
                cursor.continue();
                resolve({ value, done: false });
              } else {
                resolve({ value: undefined, done: true });
              }
            };
            
            request.onerror = () => reject(request.error);
          });
        }
      };
    }
  };
}

/**
 * 统计证书数量
 * @param {string} namespace
 * @param {Object} query - 查询条件 { role, issuer, subject }
 * @returns {Promise<number>}
 */
export async function countCerts(namespace, query = {}) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CERT_STORE_NAME], "readonly");
    const store = transaction.objectStore(CERT_STORE_NAME);
    
    const { role, issuer, subject } = query;
    const hasRole = role !== undefined;
    const hasIssuer = issuer !== undefined;
    const hasSubject = subject !== undefined;
    
    // 确定使用哪个索引
    let indexName = null;
    let indexKey = null;
    
    if (hasRole && hasIssuer && hasSubject) {
      indexName = "role_issuer_subject";
      indexKey = [role, issuer, subject];
    } else if (hasRole && hasIssuer) {
      indexName = "role_issuer";
      indexKey = [role, issuer];
    } else if (hasRole && hasSubject) {
      indexName = "role_subject";
      indexKey = [role, subject];
    } else if (hasIssuer && hasSubject) {
      indexName = "issuer_subject";
      indexKey = [issuer, subject];
    } else if (hasRole) {
      indexName = "role";
      indexKey = role;
    } else if (hasIssuer) {
      indexName = "issuer";
      indexKey = issuer;
    } else if (hasSubject) {
      indexName = "subject";
      indexKey = subject;
    }
    
    let request;
    if (indexName) {
      const index = store.index(indexName);
      request = index.count(indexKey);
    } else {
      request = store.count();
    }
    
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 保存服务器列表
 * @param {string} namespace
 * @param {string[]} servers - 服务器 URL 数组
 */
export async function saveServerList(namespace, servers) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(servers, "servers");
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 获取服务器列表
 * @param {string} namespace
 * @returns {Promise<string[] | null>}
 */
export async function getServerList(namespace) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get("servers");
    request.onsuccess = (event) => {
      resolve(event.target.result || null);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * 保存用户信息
 * @param {string} namespace
 * @param {Object} infoData - 用户信息数据
 */
export async function saveUserInfo(namespace, infoData) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.put(infoData, "info");

    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 获取用户信息
 * @param {string} namespace
 * @returns {Promise<Object | null>}
 */
export async function getUserInfo(namespace) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get("info");

    request.onsuccess = (event) => {
      resolve(event.target.result || null);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * 保存名片
 * 若已存在同一 userId 的名片，保留 signTime 更大的那张
 * @param {string} namespace
 * @param {Object} cardData - 已签名的名片数据（含 userId, signTime 等）
 * @returns {Promise<boolean>} 是否成功保存（false 表示已有更新或相同时间的名片，未覆盖）
 */
export async function saveCardToDb(namespace, cardData) {
  if (!namespace) throw new Error("namespace is required");
  if (!cardData.userId) throw new Error("cardData.userId is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CARD_STORE_NAME], "readwrite");
    const store = transaction.objectStore(CARD_STORE_NAME);

    const getRequest = store.get(cardData.userId);
    getRequest.onsuccess = (event) => {
      const existing = event.target.result;
      if (existing && existing.signTime >= cardData.signTime) {
        resolve(false);
        return;
      }
      const putRequest = store.put(cardData);
      putRequest.onsuccess = () => resolve(true);
      putRequest.onerror = () => reject(putRequest.error);
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * 获取名片
 * @param {string} namespace
 * @param {string} userId
 * @returns {Promise<Object | null>}
 */
export async function getCardFromDb(namespace, userId) {
  if (!namespace) throw new Error("namespace is required");
  if (!userId) throw new Error("userId is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CARD_STORE_NAME], "readonly");
    const store = transaction.objectStore(CARD_STORE_NAME);
    const request = store.get(userId);
    request.onsuccess = (event) => resolve(event.target.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 获取所有名片
 * @param {string} namespace
 * @returns {Promise<Array>}
 */
export async function getAllCardsFromDb(namespace) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CARD_STORE_NAME], "readonly");
    const store = transaction.objectStore(CARD_STORE_NAME);
    const request = store.getAll();
    request.onsuccess = (event) => resolve(event.target.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 删除名片
 * @param {string} namespace
 * @param {string} userId
 * @returns {Promise}
 */
export async function deleteCardFromDb(namespace, userId) {
  if (!namespace) throw new Error("namespace is required");
  if (!userId) throw new Error("userId is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CARD_STORE_NAME], "readwrite");
    const store = transaction.objectStore(CARD_STORE_NAME);
    const request = store.delete(userId);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 遍历名片
 * @param {string} namespace
 * @returns {AsyncIterable}
 */
export function iterateCards(namespace) {
  if (!namespace) throw new Error("namespace is required");
  return {
    [Symbol.asyncIterator]() {
      let db = null;
      let request = null;
      return {
        async next() {
          if (!db) {
            db = await getDb(namespace);
            const transaction = db.transaction([CARD_STORE_NAME], "readonly");
            const store = transaction.objectStore(CARD_STORE_NAME);
            request = store.openCursor();
          }
          return new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
              const cursor = event.target.result;
              if (cursor) {
                const value = cursor.value;
                cursor.continue();
                resolve({ value, done: false });
              } else {
                resolve({ value: undefined, done: true });
              }
            };
            request.onerror = () => reject(request.error);
          });
        }
      };
    }
  };
}

/**
 * 统计名片数量
 * @param {string} namespace
 * @returns {Promise<number>}
 */
export async function countCards(namespace) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CARD_STORE_NAME], "readonly");
    const store = transaction.objectStore(CARD_STORE_NAME);
    const request = store.count();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// 用户存储登记键：data store 中的键名。
// 记录该用户通过 LocalUser.getStorage() 创建的全部存储空间 id，
// 供 deleteUser 联动清理，避免删除用户后残留 nos-storage-* 数据库。
const USER_STORAGES_KEY = "user-storages";

/**
 * 登记用户创建的存储空间 id，供 deleteUser 联动清理
 * @param {string} namespace
 * @param {string} storageId
 * @returns {Promise<void>}
 */
export async function addUserStorageId(namespace, storageId) {
  if (!namespace) throw new Error("namespace is required");
  if (!storageId) throw new Error("storageId is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(USER_STORAGES_KEY);
    getRequest.onsuccess = () => {
      const list = getRequest.result || [];
      if (list.includes(storageId)) {
        resolve();
        return;
      }
      list.push(storageId);
      const putRequest = store.put(list, USER_STORAGES_KEY);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * 读取用户登记的全部存储空间 id
 * @param {string} namespace
 * @returns {Promise<string[]>}
 */
export async function getUserStorageIds(namespace) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(USER_STORAGES_KEY);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}

// 共享存储登记键：data store 中的键名。
// 记录该用户通过 LocalUser.shareStorage() 显式开放共享的存储空间名，
// 供入站 __storage_req 做第二道校验（须已显式开启才可被远端访问）。
const SHARED_STORAGES_KEY = "shared-storages";

/**
 * 登记一个显式共享的存储空间名（幂等）
 * @param {string} namespace
 * @param {string} name - 存储空间名（须以 "share:" 开头，由调用方校验）
 * @returns {Promise<void>}
 */
export async function addSharedStorage(namespace, name) {
  if (!namespace) throw new Error("namespace is required");
  if (!name) throw new Error("name is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(SHARED_STORAGES_KEY);
    getRequest.onsuccess = () => {
      const list = getRequest.result || [];
      if (list.includes(name)) {
        resolve();
        return;
      }
      list.push(name);
      const putRequest = store.put(list, SHARED_STORAGES_KEY);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * 移除一个共享登记（revoke）
 * @param {string} namespace
 * @param {string} name
 * @returns {Promise<void>}
 */
export async function removeSharedStorage(namespace, name) {
  if (!namespace) throw new Error("namespace is required");
  if (!name) throw new Error("name is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const getRequest = store.get(SHARED_STORAGES_KEY);
    getRequest.onsuccess = () => {
      const list = getRequest.result || [];
      const index = list.indexOf(name);
      if (index === -1) {
        resolve();
        return;
      }
      list.splice(index, 1);
      const putRequest = store.put(list, SHARED_STORAGES_KEY);
      putRequest.onsuccess = () => resolve();
      putRequest.onerror = () => reject(putRequest.error);
    };
    getRequest.onerror = () => reject(getRequest.error);
  });
}

/**
 * 读取全部已显式共享的存储空间名
 * @param {string} namespace
 * @returns {Promise<string[]>}
 */
export async function getSharedStorages(namespace) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([STORE_NAME], "readonly");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.get(SHARED_STORAGES_KEY);
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error);
  });
}
