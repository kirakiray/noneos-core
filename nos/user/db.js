const STORE_NAME = "keys";
const CERT_STORE_NAME = "certs";
const DB_VERSION = 3;

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
        certStore.createIndex("issuedBy", "issuedBy", { unique: false });
        certStore.createIndex("issuedTo", "issuedTo", { unique: false });
        // 复合索引
        certStore.createIndex("role_issuedBy", ["role", "issuedBy"], { unique: false });
        certStore.createIndex("role_issuedTo", ["role", "issuedTo"], { unique: false });
        certStore.createIndex("issuedBy_issuedTo", ["issuedBy", "issuedTo"], { unique: false });
        certStore.createIndex("role_issuedBy_issuedTo", ["role", "issuedBy", "issuedTo"], { unique: false });
      } else {
        // 已存在的 store，添加索引
        const transaction = event.target.transaction;
        const certStore = transaction.objectStore(CERT_STORE_NAME);
        
        const indexes = [
          { name: "role", keyPath: "role" },
          { name: "issuedBy", keyPath: "issuedBy" },
          { name: "issuedTo", keyPath: "issuedTo" },
          { name: "role_issuedBy", keyPath: ["role", "issuedBy"] },
          { name: "role_issuedTo", keyPath: ["role", "issuedTo"] },
          { name: "issuedBy_issuedTo", keyPath: ["issuedBy", "issuedTo"] },
          { name: "role_issuedBy_issuedTo", keyPath: ["role", "issuedBy", "issuedTo"] },
        ];
        
        for (const { name, keyPath } of indexes) {
          if (!certStore.indexNames.contains(name)) {
            certStore.createIndex(name, keyPath, { unique: false });
          }
        }
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
    const request = store.put(keys, "default");

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
    const request = store.get("default");

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
 * @param {Object} query - 查询条件 { role, issuedBy, issuedTo }
 * @returns {Promise<Array>}
 */
export async function getCertsFromDb(namespace, query = {}) {
  if (!namespace) throw new Error("namespace is required");
  const db = await getDb(namespace);
  
  const { role, issuedBy, issuedTo } = query;
  const hasRole = role !== undefined;
  const hasIssuedBy = issuedBy !== undefined;
  const hasIssuedTo = issuedTo !== undefined;
  
  // 确定使用哪个索引
  let indexName = null;
  let indexKey = null;
  
  if (hasRole && hasIssuedBy && hasIssuedTo) {
    indexName = "role_issuedBy_issuedTo";
    indexKey = [role, issuedBy, issuedTo];
  } else if (hasRole && hasIssuedBy) {
    indexName = "role_issuedBy";
    indexKey = [role, issuedBy];
  } else if (hasRole && hasIssuedTo) {
    indexName = "role_issuedTo";
    indexKey = [role, issuedTo];
  } else if (hasIssuedBy && hasIssuedTo) {
    indexName = "issuedBy_issuedTo";
    indexKey = [issuedBy, issuedTo];
  } else if (hasRole) {
    indexName = "role";
    indexKey = role;
  } else if (hasIssuedBy) {
    indexName = "issuedBy";
    indexKey = issuedBy;
  } else if (hasIssuedTo) {
    indexName = "issuedTo";
    indexKey = issuedTo;
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
