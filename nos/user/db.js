const STORE_NAME = "data";
const CERT_STORE_NAME = "certs";
const DB_VERSION = 4;

/**
 * 获取数据库实例
 * @param {string} namespace
 * @returns {Promise<IDBDatabase>}
 */
function getDb(namespace) {
  return new Promise((resolve, reject) => {
    const dbName = `nos_user_${namespace}`;
    const request = indexedDB.open(dbName, DB_VERSION);

    request.onerror = () => {
      reject(request.error);
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
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
    };
  });
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
