// DataPublisher 专用 IndexedDB 数据库
// 独立于 nos/user/db.js，不依赖 user namespace
// 数据库名约定为 nos_publish_data，版本号从 1 开始

const DB_NAME = "nos_publish_data";
const DB_VERSION = 1;
const CHUNK_STORE = "file_chunks";
const MANIFEST_STORE = "file_manifests";

// 单例连接缓存，避免每次操作重新打开数据库
let dbPromise = null;

/**
 * 获取数据库实例（单例）
 * @returns {Promise<IDBDatabase>}
 */
function getDb() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

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

  return dbPromise;
}

/**
 * 存入一个块
 * @param {string} chunkHash - 块的 SHA-256 哈希值
 * @param {ArrayBuffer|Uint8Array} data - 块原始二进制数据
 */
export async function saveChunk(chunkHash, data) {
  const db = await getDb();
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
 * @param {string} chunkHash - 块的 SHA-256 哈希值
 * @returns {Promise<ArrayBuffer|null>}
 */
export async function getChunk(chunkHash) {
  const db = await getDb();
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
 * @param {string} fileHash - 整个文件的 SHA-256 哈希值
 * @param {Object} manifest - manifest 对象（含签名）
 */
export async function saveManifest(fileHash, manifest) {
  const db = await getDb();
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
 * @param {string} fileHash - 整个文件的 SHA-256 哈希值
 * @returns {Promise<Object|null>}
 */
export async function getManifest(fileHash) {
  const db = await getDb();
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
 * @param {string} chunkHash - 块的 SHA-256 哈希值
 */
export async function deleteChunk(chunkHash) {
  const db = await getDb();
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
 * @param {string} fileHash - 整个文件的 SHA-256 哈希值
 */
export async function deleteManifest(fileHash) {
  const db = await getDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([MANIFEST_STORE], "readwrite");
    const store = transaction.objectStore(MANIFEST_STORE);
    const request = store.delete(fileHash);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
