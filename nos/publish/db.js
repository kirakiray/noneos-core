// DataPublisher 专用 IndexedDB 数据库
// 每个 namespace 使用独立的数据库，数据库命名规则：nos_publish_data_<namespace>
// 版本号从 1 开始

const DB_VERSION = 2;
const CHUNK_STORE = "file_chunks";
const MANIFEST_STORE = "file_manifests";
const PUBLISHED_APPS_STORE = "published_apps";
const FILE_REFS_STORE = "file_refs";
const RECOMMENDATIONS_STORE = "recommendations";

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
      const oldVersion = event.oldVersion || 0;

      if (oldVersion < 1) {
        // Version 1 stores
        if (!db.objectStoreNames.contains(CHUNK_STORE)) {
          // key: chunkHash (string)，value: 块原始二进制数据 (ArrayBuffer)
          db.createObjectStore(CHUNK_STORE);
        }
        if (!db.objectStoreNames.contains(MANIFEST_STORE)) {
          // key: fileHash (string)，value: manifest 对象（含签名）
          db.createObjectStore(MANIFEST_STORE);
        }
      }

      if (oldVersion < 2) {
        // Version 2 stores — AppManager
        if (!db.objectStoreNames.contains(PUBLISHED_APPS_STORE)) {
          // key: appName (string)，value: { appId, appName, version, manifestHash, publisherUserId, status, publishedAt, updatedAt }
          db.createObjectStore(PUBLISHED_APPS_STORE, { keyPath: "appName" });
        }
        if (!db.objectStoreNames.contains(FILE_REFS_STORE)) {
          // key: fileHash (string)，value: { fileHash, refCount, appIds: [appId] }
          db.createObjectStore(FILE_REFS_STORE, { keyPath: "fileHash" });
        }
        if (!db.objectStoreNames.contains(RECOMMENDATIONS_STORE)) {
          // key: id (string)，value: { id, appId, appName, publisherUserId, recommendedAt }
          db.createObjectStore(RECOMMENDATIONS_STORE, { keyPath: "id" });
        }
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

// ───── AppManager 相关：published_apps ─────

/**
 * 保存或更新已发布应用的记录
 * @param {string} namespace - 用户命名空间
 * @param {Object} record - { appId, appName, version, manifestHash, publisherUserId, status, publishedAt, updatedAt }
 */
export async function savePublishedApp(namespace, record) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([PUBLISHED_APPS_STORE], "readwrite");
    const store = transaction.objectStore(PUBLISHED_APPS_STORE);
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 根据 appName 获取已发布应用的记录
 * @param {string} namespace - 用户命名空间
 * @param {string} appName - 应用名称
 * @returns {Promise<Object|null>}
 */
export async function getPublishedApp(namespace, appName) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([PUBLISHED_APPS_STORE], "readonly");
    const store = transaction.objectStore(PUBLISHED_APPS_STORE);
    const request = store.get(appName);
    request.onsuccess = (event) => resolve(event.target.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 获取所有已发布应用的记录
 * @param {string} namespace - 用户命名空间
 * @returns {Promise<Object[]>}
 */
export async function listPublishedApps(namespace) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([PUBLISHED_APPS_STORE], "readonly");
    const store = transaction.objectStore(PUBLISHED_APPS_STORE);
    const request = store.getAll();
    request.onsuccess = (event) => resolve(event.target.result || []);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 删除已发布应用的记录
 * @param {string} namespace - 用户命名空间
 * @param {string} appName - 应用名称
 */
export async function deletePublishedApp(namespace, appName) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([PUBLISHED_APPS_STORE], "readwrite");
    const store = transaction.objectStore(PUBLISHED_APPS_STORE);
    const request = store.delete(appName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

// ───── AppManager 相关：file_refs ─────

/**
 * 保存文件引用计数
 * @param {string} namespace - 用户命名空间
 * @param {Object} ref - { fileHash, refCount, appIds }
 */
export async function saveFileRef(namespace, ref) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([FILE_REFS_STORE], "readwrite");
    const store = transaction.objectStore(FILE_REFS_STORE);
    const request = store.put(ref);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 根据 fileHash 获取文件引用记录
 * @param {string} namespace - 用户命名空间
 * @param {string} fileHash - 文件哈希
 * @returns {Promise<Object|null>}
 */
export async function getFileRef(namespace, fileHash) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([FILE_REFS_STORE], "readonly");
    const store = transaction.objectStore(FILE_REFS_STORE);
    const request = store.get(fileHash);
    request.onsuccess = (event) => resolve(event.target.result || null);
    request.onerror = () => reject(request.error);
  });
}

/**
 * 增加文件的引用计数
 * @param {string} namespace - 用户命名空间
 * @param {string} fileHash - 文件哈希
 * @param {string} appId - 应用 ID
 */
export async function incrementFileRef(namespace, fileHash, appId) {
  const ref = await getFileRef(namespace, fileHash);
  if (ref) {
    ref.refCount = (ref.refCount || 0) + 1;
    if (!ref.appIds.includes(appId)) {
      ref.appIds.push(appId);
    }
    await saveFileRef(namespace, ref);
  } else {
    await saveFileRef(namespace, {
      fileHash,
      refCount: 1,
      appIds: [appId],
    });
  }
}

/**
 * 减少文件的引用计数，降到 0 时删除该文件的 manifest 和 chunks
 * @param {string} namespace - 用户命名空间
 * @param {string} fileHash - 文件哈希
 * @param {string} appId - 应用 ID
 */
export async function decrementFileRef(namespace, fileHash, appId) {
  const ref = await getFileRef(namespace, fileHash);
  if (!ref) return;

  ref.refCount = Math.max(0, (ref.refCount || 1) - 1);
  const idx = ref.appIds.indexOf(appId);
  if (idx !== -1) ref.appIds.splice(idx, 1);

  if (ref.refCount <= 0) {
    // 清理文件数据
    // 先获取 manifest 拿到 chunkHashes，再删 manifest
    const manifest = await getManifest(namespace, fileHash);
    await deleteManifest(namespace, fileHash);
    if (manifest && manifest.chunkHashes) {
      await Promise.all(
        manifest.chunkHashes.map((ch) => deleteChunk(namespace, ch)),
      );
    }
    // 删除引用记录
    const db = await getDb(namespace);
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([FILE_REFS_STORE], "readwrite");
      const store = transaction.objectStore(FILE_REFS_STORE);
      const request = store.delete(fileHash);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } else {
    await saveFileRef(namespace, ref);
  }
}

// ───── AppManager 相关：recommendations ─────

/**
 * 保存推荐记录
 * @param {string} namespace - 用户命名空间
 * @param {Object} record - { id, appId, appName, publisherUserId, recommendedAt }
 */
export async function saveRecommendation(namespace, record) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RECOMMENDATIONS_STORE], "readwrite");
    const store = transaction.objectStore(RECOMMENDATIONS_STORE);
    const request = store.put(record);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

/**
 * 根据 appId + publisherUserId 获取推荐记录
 * @param {string} namespace - 用户命名空间
 * @param {string} appId - 应用 ID
 * @param {string} publisherUserId - 发布者用户 ID
 * @returns {Promise<Object|null>}
 */
export async function getRecommendation(namespace, appId, publisherUserId) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RECOMMENDATIONS_STORE], "readonly");
    const store = transaction.objectStore(RECOMMENDATIONS_STORE);
    const request = store.getAll();
    request.onsuccess = (event) => {
      const all = event.target.result || [];
      const found = all.find((r) => r.appId === appId && r.publisherUserId === publisherUserId);
      resolve(found || null);
    };
    request.onerror = () => reject(request.error);
  });
}

/**
 * 删除推荐记录
 * @param {string} namespace - 用户命名空间
 * @param {string} appId - 应用 ID
 * @param {string} publisherUserId - 发布者用户 ID
 */
export async function deleteRecommendation(namespace, appId, publisherUserId) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RECOMMENDATIONS_STORE], "readwrite");
    const store = transaction.objectStore(RECOMMENDATIONS_STORE);
    // 先查后删
    const getAllReq = store.getAll();
    getAllReq.onsuccess = () => {
      const all = getAllReq.result || [];
      const found = all.find((r) => r.appId === appId && r.publisherUserId === publisherUserId);
      if (found) {
        const delReq = store.delete(found.id);
        delReq.onsuccess = () => resolve();
        delReq.onerror = () => reject(delReq.error);
      } else {
        resolve();
      }
    };
    getAllReq.onerror = () => reject(getAllReq.error);
  });
}

/**
 * 获取所有推荐记录
 * @param {string} namespace - 用户命名空间
 * @returns {Promise<Object[]>}
 */
export async function listRecommendations(namespace) {
  const db = await getDb(namespace);
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([RECOMMENDATIONS_STORE], "readonly");
    const store = transaction.objectStore(RECOMMENDATIONS_STORE);
    const request = store.getAll();
    request.onsuccess = (event) => resolve(event.target.result || []);
    request.onerror = () => reject(request.error);
  });
}

// ───── 清理 ─────

/**
 * 清理指定 namespace 的全部发布数据（删除整个 IndexedDB 数据库）
 * 先关闭缓存中的连接，再删除数据库
 * @param {string} namespace - 用户命名空间
 * @returns {Promise<void>}
 */
export async function clearPublishData(namespace) {
  if (!namespace) {
    throw new Error("namespace is required");
  }

  const dbName = `nos_publish_data_${namespace}`;

  // 关闭缓存中的连接
  const cached = dbCache.get(namespace);
  if (cached) {
    const db = await cached;
    db.close();
    dbCache.delete(namespace);
  }

  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(dbName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}
