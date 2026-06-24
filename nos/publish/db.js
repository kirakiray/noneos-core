// DataPublisher 专用 IndexedDB 数据库
// 每个 namespace 使用独立的数据库，数据库命名规则：nos_publish_data_<namespace>
// 版本号从 1 开始

const DB_VERSION = 1;
const CHUNK_STORE = "file_chunks";
const MANIFEST_STORE = "file_manifests";

// 数据库连接缓存，key 为 namespace
const dbCache = new Map();

/**
 * 获取数据库实例（按 namespace 缓存）
 * @param {string} namespace - 用户命名空间
 * @returns {Promise<IDBDatabase>}
 */
function getDb(namespace) {
  if (!namespace) {
    throw new Error("namespace is required");
  }

  if (dbCache.has(namespace)) {
    return dbCache.get(namespace);
  }

  const dbName = `nos_publish_data_${namespace}`;

  const dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(dbName, DB_VERSION);

    request.onerror = () => reject(request.error);

    request.onsuccess = (event) => resolve(event.target.result);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(CHUNK_STORE)) {
        // key: chunkHash (string)，value: 块原始二进制数据 (ArrayBuffer)
        db.createObjectStore(CHUNK_STORE);
      }
      if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
        // key: fileHash (string)，value: manifest 对象（含签名）
        db.createObjectStore(MANIFEST_STORE);
      }
    };
  });

  dbCache.set(namespace, dbPromise);
  return dbPromise;
}

/**
 * 存入一个块
 * @param {string} namespace - 用户命名空间
 * @param {string} chunkHash - 块的 SHA-256 哈希值
 * @param {ArrayBuffer|Uint8Array} data - 块原始二进制数据
 */
export async function saveChunk(namespace, chunkHash, data) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CHUNK_STORE], "readwrite");
    const store = transaction.objectStore(CHUNK_STORE);
    const request = store.put(data, chunkHash);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 读取一个块的二进制数据
 * @param {string} namespace - 用户命名空间
 * @param {string} chunkHash - 块的 SHA-256 哈希值
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getChunk(namespace, chunkHash) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CHUNK_STORE], "readonly");
    const store = transaction.objectStore(CHUNK_STORE);
    const request = store.get(chunkHash);
    request.onsuccess = (event) => resolve(event.target.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 存入一个 manifest
 * @param {string} namespace - 用户命名空间
 * @param {string} fileHash - 整个文件的 SHA-256 哈希值
 * @param {Object} manifest - manifest 对象（含签名）
 */
export async function saveManifest(namespace, fileHash, manifest) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([MANIFEST_STORE], "readwrite");
    const store = transaction.objectStore(MANIFEST_STORE);
    const request = store.put(manifest, fileHash);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 读取一个 manifest
 * @param {string} namespace - 用户命名空间
 * @param {string} fileHash - 整个文件的 SHA-256 哈希值
 * @returns {Promise<Object|null>}
 */
export async function getManifest(namespace, fileHash) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([MANIFEST_STORE], "readonly");
    const store = transaction.objectStore(MANIFEST_STORE);
    const request = store.get(fileHash);
    request.onsuccess = (event) => resolve(event.target.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 删除一个块
 * @param {string} namespace - 用户命名空间
 * @param {string} chunkHash - 块的 SHA-256 哈希值
 */
export async function deleteChunk(namespace, chunkHash) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([CHUNK_STORE], "readwrite");
    const store = transaction.objectStore(CHUNK_STORE);
    const request = store.delete(chunkHash);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 删除一个 manifest
 * @param {string} namespace - 用户命名空间
 * @param {string} fileHash - 整个文件的 SHA-256 哈希值
 */
export async function deleteManifest(namespace, fileHash) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([MANIFEST_STORE], "readwrite");
    const store = transaction.objectStore(MANIFEST_STORE);
    const request = store.delete(fileHash);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
