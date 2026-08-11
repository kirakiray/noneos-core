// NoneOS 官方存储模块
// 基于 IndexedDB 的异步键值存储，提供类 localStorage 的 API，支持跨标签页同步
// 每个存储 id 对应一个独立的 IndexedDB 数据库（nos-storage-${id}），互不阻塞

const SName = Symbol("storage-name"); // 存储标识符
const IDB = Symbol("idb"); // IndexedDB 连接 Promise
const BC = Symbol("bc"); // BroadcastChannel 实例

const DB_PREFIX = "nos-storage-"; // 数据库名前缀
const STORE_NAME = "main"; // object store 名称
const DB_VERSION = 1; // 数据库版本，固定为 1
const CHANGE_EVENT = "nos-storage-change"; // window 变更事件名
const BATCH_SIZE = 50; // entries() 每批读取条数
const HANDLE_MARK = "__nos_fs_handle__"; // nos/fs 句柄的序列化标记
// 与 nos/fs/public/base.js 的 PICKED 同一个全局符号（Symbol.for 注册）。
// 这里不 import fs 模块，避免为读一个常量而牵连加载整个文件系统。
const FS_PICKED = Symbol.for("nos-fs-picked");

/**
 * 判断是否为 nos/fs 句柄实例
 *
 * 用鸭子类型而非 instanceof，以兼容系统句柄、挂载句柄与远端句柄。
 * @param {*} value - 待检测值
 * @returns {boolean}
 */
const isFsHandle = (value) =>
  !!value &&
  typeof value === "object" &&
  typeof value.path === "string" &&
  (value.kind === "file" || value.kind === "dir") &&
  typeof value.copyTo === "function";

/**
 * 递归把 nos/fs 句柄替换为可结构化克隆的路径引用
 *
 * 句柄的状态保存在私有字段（#originHandle / #parent）中，
 * 结构化克隆会丢弃私有字段与原型，因此必须转成路径引用后再入库。
 * @param {*} value - 原始值
 * @param {WeakMap} [seen] - 循环引用记录
 * @returns {*} 可安全写入 IndexedDB 的值
 */
const toStorable = (value, seen = new WeakMap()) => {
  if (isFsHandle(value)) {
    return { [HANDLE_MARK]: true, path: value.path, kind: value.kind };
  }

  if (!value || typeof value !== "object") {
    return value;
  }

  // 仅遍历普通对象与数组，Date/Blob/Map 等原生类型交给结构化克隆处理
  const isPlain = Array.isArray(value) || value.constructor === Object;
  if (!isPlain) {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);

  for (const [k, v] of Object.entries(value)) {
    result[k] = toStorable(v, seen);
  }

  return result;
};

/**
 * 递归收集值中的所有 nos/fs 句柄
 * @param {*} value - 待扫描值
 * @param {Array} [found] - 收集结果
 * @param {WeakSet} [seen] - 循环引用记录
 * @returns {Array} 句柄列表
 */
const collectHandles = (value, found = [], seen = new WeakSet()) => {
  if (isFsHandle(value)) {
    found.push(value);
    return found;
  }

  if (!value || typeof value !== "object") {
    return found;
  }

  // 与 toStorable 保持一致的递归边界
  if (!Array.isArray(value) && value.constructor !== Object) {
    return found;
  }

  if (seen.has(value)) {
    return found;
  }
  seen.add(value);

  for (const v of Object.values(value)) {
    collectHandles(v, found, seen);
  }

  return found;
};

/**
 * 校验值中的句柄是否可被持久化
 *
 * `open()` 得到的本地目录句柄在 `mount()` 之前，其 path 只是光秃秃的目录名，
 * 读取时会被 `fs.get()` 当作 OPFS 路径处理 —— 要么抛「根目录不存在」，
 * 要么静默命中同名的 OPFS 目录（更危险）。因此 `nos/fs` 在 `open()` 返回的
 * 句柄上打了 `FS_PICKED` 标记，`mount()` 成功后移除；这里据此提前拦截。
 *
 * 子孙句柄自身没有标记，但 `root` 指向最初 `open()` 的句柄，故查 root 即可。
 * @param {*} value - 待写入的值
 * @throws {Error} 含未挂载的 open() 句柄时抛出
 */
const assertHandlesStorable = (value) => {
  for (const handle of collectHandles(value)) {
    if (handle[FS_PICKED] || handle.root?.[FS_PICKED]) {
      throw new Error(
        `nos-storage: cannot store fs handle "${handle.path}" — it comes from open() ` +
          `and is not mounted yet. Call mount(handle) first, or use open({ mount: true }).`
      );
    }
  }
};

/**
 * 递归把路径引用还原为 nos/fs 句柄实例
 *
 * 按需动态导入 nos/fs，未存句柄的调用方不会被牵连加载文件系统模块。
 * @param {*} value - 从库中读出的值
 * @param {WeakMap} [seen] - 循环引用记录
 * @returns {Promise<*>} 还原后的值
 */
const fromStorable = async (value, seen = new WeakMap()) => {
  if (!value || typeof value !== "object") {
    return value;
  }

  if (value[HANDLE_MARK]) {
    const { get } = await import("../fs/main.js");
    const handle = await get(value.path);
    if (!handle) {
      throw new Error(
        `nos-storage: fs handle "${value.path}" no longer exists`
      );
    }
    return handle;
  }

  const isPlain = Array.isArray(value) || value.constructor === Object;
  if (!isPlain) {
    return value;
  }

  if (seen.has(value)) {
    return seen.get(value);
  }

  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);

  for (const [k, v] of Object.entries(value)) {
    result[k] = await fromStorable(v, seen);
  }

  return result;
};

// 同 id 实例缓存，避免重复开库与重复派发事件
const instances = new Map();
// 同 id 的所有活跃实例（含直接 new 的），deleteStorage 需全部关闭才不会被阻塞
const liveInstances = new Map();

/**
 * 将 IDBRequest 封装为回调风格
 * @param {IDBRequest} req - IndexedDB 请求对象
 * @param {Function} onSuccess - 成功回调，接收 req.result
 * @param {Function} onError - 失败回调
 * @returns {IDBRequest} 原始请求对象
 */
const handleReq = (req, onSuccess, onError) => {
  req.onsuccess = () => onSuccess(req.result);
  req.onerror = (e) => onError(e.target.error || e);
  return req;
};

/**
 * NosStorage - 基于 IndexedDB 的异步键值存储
 *
 * 推荐通过 getStorage(id) 获取实例以复用连接，
 * 直接 new 会为同一个 id 创建重复的数据库连接与广播通道。
 */
export class NosStorage {
  /**
   * @param {string} id - 存储标识符，用于区分不同的存储空间
   */
  constructor(id = "public") {
    this[SName] = id;
    this[IDB] = this._openDB(id);
    this._initBC(id);

    const proxy = new Proxy(this, handle);
    let live = liveInstances.get(id);
    if (!live) {
      live = new Set();
      liveInstances.set(id, live);
    }
    live.add(proxy);

    return proxy;
  }

  /**
   * 创建跨标签页广播通道，把其他标签页的变更转成本页 window 事件
   * @param {string} id - 存储标识符
   * @private
   */
  _initBC(id) {
    if (typeof BroadcastChannel === "undefined") {
      return;
    }

    // 关掉旧通道，避免重连时通道累积导致事件重复派发
    this[BC]?.close();
    this[BC] = new BroadcastChannel(`${DB_PREFIX}${id}`);
    this[BC].onmessage = (e) => {
      const { key, oldValue, newValue } = e.data;
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(CHANGE_EVENT, {
            detail: { key, oldValue, newValue, storageId: id },
          })
        );
      }
    };
  }

  /**
   * 当前实例的存储标识符
   * @returns {string}
   */
  get id() {
    return this[SName];
  }

  /**
   * 派发存储变更事件（本页 window 事件 + 跨标签页广播）
   *
   * 本页事件携带还原后的句柄实例；跨标签页广播只发路径引用，
   * 因为句柄实例无法通过结构化克隆传递（私有字段会丢失）。
   * @param {string|null} key - 变更的键名，clear() 时为 null
   * @param {*} oldValue - 旧值（句柄已还原）
   * @param {*} newValue - 新值
   * @param {*} [oldRaw] - 旧值的可克隆形态，缺省时对 oldValue 现场转换
   * @private
   */
  _emitChange(key, oldValue, newValue, oldRaw) {
    const storageId = this[SName];
    if (typeof window !== "undefined") {
      window.dispatchEvent(
        new CustomEvent(CHANGE_EVENT, {
          detail: { key, oldValue, newValue, storageId },
        })
      );
    }

    this[BC]?.postMessage({
      key,
      oldValue: oldRaw === undefined ? toStorable(oldValue) : oldRaw,
      newValue: toStorable(newValue),
      storageId,
    });
  }

  /**
   * 打开数据库，连接被外部关闭时自动重连
   * @param {string} id - 存储标识符
   * @returns {Promise<IDBDatabase>}
   * @private
   */
  _openDB(id) {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(`${DB_PREFIX}${id}`, DB_VERSION);

      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: "key" });
        }
      };

      req.onsuccess = () => {
        const db = req.result;
        // 页面回收或被外部 close() 后，下次操作前重新建立连接
        db.onclose = () => {
          this[IDB] = this._openDB(id);
        };
        resolve(db);
      };

      // 其他标签页持有更高版本的连接导致阻塞
      req.onblocked = () => {
        reject(
          new Error(`nos-storage: open blocked for "${id}", close other tabs`)
        );
      };

      req.onerror = (e) => reject(e.target.error || e);
    });
  }

  /**
   * 在事务中执行 object store 操作
   *
   * 显式 close() 不会触发 db.onclose（规范只在异常终止时触发），
   * 因此建事务失败时需就地重开连接并重试一次。
   * @param {"readonly"|"readwrite"} mode - 事务模式
   * @param {Function} callback - 接收 (store, resolve, reject)
   * @param {boolean} [retried] - 是否已重试过，防止无限递归
   * @returns {Promise<*>}
   * @private
   */
  _withStore(mode, callback, retried) {
    return this[IDB].then((db) => {
      let store;
      try {
        store = db.transaction([STORE_NAME], mode).objectStore(STORE_NAME);
      } catch (err) {
        if (!retried && err.name === "InvalidStateError") {
          this[IDB] = this._openDB(this[SName]);
          this._initBC(this[SName]);
          return this._withStore(mode, callback, true);
        }
        throw err;
      }

      return new Promise((resolve, reject) => {
        callback(store, resolve, reject);
      });
    });
  }

  /**
   * 执行写操作并派发变更事件（写入前先读取旧值）
   * @param {string} key - 键名
   * @param {Function} actionFn - 接收 store，返回 IDBRequest
   * @param {*} newValue - 新值
   * @returns {Promise<true>}
   * @private
   */
  _mutateItem(key, actionFn, newValue) {
    return this._withStore("readwrite", (store, resolve, reject) => {
      handleReq(
        store.get(key),
        (result) => {
          const oldRaw = result ? result.value : null;
          handleReq(
            actionFn(store),
            () => {
              // 先还原旧值再派发，保证 await 返回时事件已触发（时序确定）
              fromStorable(oldRaw)
                .catch(() => oldRaw) // 句柄已失效则降级为路径引用，不阻断写入
                .then((oldValue) => {
                  this._emitChange(key, oldValue, newValue, oldRaw);
                  resolve(true);
                });
            },
            reject
          );
        },
        reject
      );
    });
  }

  /**
   * 存储数据
   *
   * nos/fs 句柄会被转为路径引用存储，读取时自动还原为句柄实例。
   * 若句柄来自 `open()` 且未 `mount()`，抛错而非静默写入不可还原的路径。
   * @param {string} key - 键名
   * @param {*} value - 值，支持所有可结构化克隆的类型及 nos/fs 句柄
   * @returns {Promise<true>}
   */
  setItem(key, value) {
    assertHandlesStorable(value);

    const stored = toStorable(value);
    return this._mutateItem(key, (store) => store.put({ key, value: stored }), value);
  }

  /**
   * 读取数据
   * @param {string} key - 键名
   * @returns {Promise<*>} 键不存在时返回 null；存入的 nos/fs 句柄会还原为句柄实例
   */
  async getItem(key) {
    const raw = await this._withStore("readonly", (store, resolve, reject) => {
      handleReq(
        store.get(key),
        (result) => resolve(result ? result.value : null),
        reject
      );
    });

    return fromStorable(raw);
  }

  /**
   * 判断键是否存在（不读取值，可区分"值为 null"与"键不存在"）
   * @param {string} key - 键名
   * @returns {Promise<boolean>}
   */
  has(key) {
    return this._withStore("readonly", (store, resolve, reject) => {
      handleReq(store.count(key), (count) => resolve(count > 0), reject);
    });
  }

  /**
   * 删除数据
   * @param {string} key - 键名
   * @returns {Promise<true>}
   */
  removeItem(key) {
    return this._mutateItem(key, (store) => store.delete(key), null);
  }

  /**
   * 清空当前存储空间的所有数据
   * @returns {Promise<true>} 派发的变更事件中 key/oldValue/newValue 均为 null
   */
  clear() {
    return this._withStore("readwrite", (store, resolve, reject) => {
      handleReq(
        store.clear(),
        () => {
          this._emitChange(null, null, null);
          resolve(true);
        },
        reject
      );
    });
  }

  /**
   * 按索引获取键名
   * @param {number} index - 索引位置
   * @returns {Promise<string|undefined>} 越界时返回 undefined
   */
  key(index) {
    return this._withStore("readonly", (store, resolve, reject) => {
      const req = store.openKeyCursor();
      let advanced = false;
      req.onsuccess = () => {
        const cur = req.result;
        if (!cur) return resolve(undefined);
        if (index === 0 || advanced) return resolve(cur.key);

        advanced = true;
        cur.advance(index);
      };
      req.onerror = (e) => reject(e.target.error || e);
    });
  }

  /**
   * 键值对数量
   * @returns {Promise<number>} 异步属性，必须 await
   */
  get length() {
    return this._withStore("readonly", (store, resolve, reject) => {
      handleReq(store.count(), resolve, reject);
    });
  }

  /**
   * 遍历所有键值对，按批分页避免长事务
   * @yields {[string, *]} [键, 值]，存入的 nos/fs 句柄会还原为句柄实例
   */
  async *entries() {
    let lastKey;
    let hasMore = true;

    while (hasMore) {
      const batch = await this._withStore(
        "readonly",
        (store, resolve, reject) => {
          const req =
            lastKey !== undefined
              ? store.openCursor(IDBKeyRange.lowerBound(lastKey, true))
              : store.openCursor();
          const items = [];

          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve({ items, hasMore: false });
              return;
            }

            items.push([cursor.key, cursor.value.value]);
            if (items.length < BATCH_SIZE) {
              cursor.continue();
            } else {
              resolve({ items, hasMore: true });
            }
          };
          req.onerror = (e) => reject(e.target.error || e);
        }
      );

      for (const [key, value] of batch.items) {
        yield [key, await fromStorable(value)];
      }

      hasMore = batch.hasMore;
      if (hasMore) {
        lastKey = batch.items[batch.items.length - 1][0];
      }
    }
  }

  /**
   * 遍历所有键名
   *
   * 直接走键游标，不读取也不还原值，遍历大量句柄时明显更快。
   * @yields {string}
   */
  async *keys() {
    let lastKey;
    let hasMore = true;

    while (hasMore) {
      const batch = await this._withStore(
        "readonly",
        (store, resolve, reject) => {
          const req =
            lastKey !== undefined
              ? store.openKeyCursor(IDBKeyRange.lowerBound(lastKey, true))
              : store.openKeyCursor();
          const items = [];

          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve({ items, hasMore: false });
              return;
            }

            items.push(cursor.key);
            if (items.length < BATCH_SIZE) {
              cursor.continue();
            } else {
              resolve({ items, hasMore: true });
            }
          };
          req.onerror = (e) => reject(e.target.error || e);
        }
      );

      for (const key of batch.items) {
        yield key;
      }

      hasMore = batch.hasMore;
      if (hasMore) {
        lastKey = batch.items[batch.items.length - 1];
      }
    }
  }

  /**
   * 遍历所有值
   * @yields {*} 存入的 nos/fs 句柄会还原为句柄实例
   */
  async *values() {
    for await (const [, value] of this.entries()) {
      yield value;
    }
  }

  /**
   * 关闭数据库连接与广播通道
   *
   * 关闭后实例仍可继续使用，下次操作会自动重开连接。
   * @returns {Promise<void>}
   */
  async close() {
    this[BC]?.close();
    this[BC] = undefined;
    const db = await this[IDB];
    db.onclose = null;
    db.close();
  }
}

/**
 * Proxy 处理器：支持 storage.key 形式的读写删
 * 注意错误会被静默忽略，需要处理错误请改用方法调用
 */
const handle = {
  get(target, key, receiver) {
    if (key in target || typeof key === "symbol" || key === "then") {
      return Reflect.get(target, key, receiver);
    }

    return target.getItem(key);
  },
  set(target, key, value) {
    // symbol 为内部私有属性（如重连时回写 IDB 连接），不可当作存储项
    if (typeof key === "symbol") {
      return Reflect.set(target, key, value);
    }

    target.setItem(key, value).catch(() => {});
    return true;
  },
  deleteProperty(target, key) {
    if (typeof key === "symbol") {
      return Reflect.deleteProperty(target, key);
    }

    target.removeItem(key).catch(() => {});
    return true;
  },
};

/**
 * 获取指定 id 的存储实例，同 id 复用同一实例
 * @param {string} id - 存储标识符
 * @returns {NosStorage}
 */
export function getStorage(id = "public") {
  let ins = instances.get(id);
  if (!ins) {
    ins = new NosStorage(id);
    instances.set(id, ins);
  }
  return ins;
}

/**
 * 删除指定 id 的整个数据库
 *
 * 会先关闭该 id 下所有活跃实例的连接，否则删除会被占用的连接阻塞。
 * @param {string} id - 存储标识符
 * @returns {Promise<true>}
 */
export async function deleteStorage(id) {
  instances.delete(id);

  const live = liveInstances.get(id);
  if (live) {
    await Promise.all([...live].map((ins) => ins.close()));
    liveInstances.delete(id);
  }

  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase(`${DB_PREFIX}${id}`);
    req.onsuccess = () => resolve(true);
    req.onerror = (e) => reject(e.target.error || e);
    // 其他连接尚未关闭，删除被延后而非失败；连接关闭后仍会走 onsuccess
    req.onblocked = () => {
      console.warn(
        `nos-storage: delete of "${id}" is blocked by an open connection, waiting`
      );
    };
  });
}

/**
 * 默认存储实例（id 为 "public"）
 */
export const storage = getStorage();
