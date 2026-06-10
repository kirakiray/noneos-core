const STORE_NAME = "keys";
const CERT_STORE_NAME = "certs";
const DB_VERSION = 2;

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
        db.createObjectStore(CERT_STORE_NAME, { keyPath: "id" });
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
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CERT_STORE_NAME], "readonly");
    const store = transaction.objectStore(CERT_STORE_NAME);
    const request = store.getAll();

    request.onsuccess = (event) => {
      let certs = event.target.result || [];
      // 在内存中过滤
      if (query.role !== undefined) certs = certs.filter((c) => c.role === query.role);
      if (query.issuedBy !== undefined) certs = certs.filter((c) => c.issuedBy === query.issuedBy);
      if (query.issuedTo !== undefined) certs = certs.filter((c) => c.issuedTo === query.issuedTo);
      resolve(certs);
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
