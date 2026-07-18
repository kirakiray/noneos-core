/* noneos-core version: 4.2.0 */
(function () {
  'use strict';

  let rootHandle = null;

  /**
   * 获取根目录句柄
   * @returns {Promise<FileSystemDirectoryHandle>} 根目录句柄
   */
  const getRootDirectory = async () => {
    if (!rootHandle) {
      rootHandle = await navigator.storage.getDirectory();
    }

    return rootHandle;
  };

  /**
   * 获取文件句柄
   * @param {Object} options - 选项
   * @param {string} options.path - 文件路径
   * @param {boolean} [options.create] - 是否创建文件（如果不存在）
   * @returns {Promise<FileSystemFileHandle>} 文件句柄
   */
  const getFileHandle = async ({ path, create }) => {
    const rootHandle = await getRootDirectory();

    const paths = path.split("/");
    if (paths[0] === "") {
      paths.shift();
    }

    let currentHandle = rootHandle;
    let lastId = paths.length - 1;
    for (let i = 0; i < lastId; i++) {
      if (i == lastId) {
        break;
      }
      const p = paths[i];
      currentHandle = await currentHandle.getDirectoryHandle(p, { create });
    }

    const fileHandle = await currentHandle.getFileHandle(
      paths[paths.length - 1],
      { create }
    );

    return fileHandle;
  };

  /**
   * 根据文件扩展名获取 Content-Type
   * @param {string} path - 文件路径
   * @returns {string} Content-Type 值
   */
  const getContentType = (path) => {
    const prefix = path.split(".").slice(-1)[0];

    switch (prefix) {
      case "html":
      case "htm":
        return "text/html; charset=utf-8";
      case "txt":
      case "md":
        return "text/plain; charset=utf-8";
      case "js":
      case "mjs":
        return "application/javascript; charset=utf-8";
      case "json":
        return "application/json; charset=utf-8";
      case "css":
        return "text/css; charset=utf-8";
      case "xml":
        return "application/xml; charset=utf-8";
      case "svg":
        return "image/svg+xml; charset=utf-8";
      case "csv":
        return "text/csv; charset=utf-8";
      case "ics":
        return "text/calendar; charset=utf-8";
      case "pdf":
        return "application/pdf; charset=utf-8";
      case "doc":
      case "docx":
        return "application/msword; charset=utf-8";
      case "xls":
      case "xlsx":
        return "application/vnd.ms-excel; charset=utf-8";
      case "ppt":
      case "pptx":
        return "application/vnd.ms-powerpoint; charset=utf-8";
      case "zip":
        return "application/zip; charset=utf-8";
      case "gz":
        return "application/gzip; charset=utf-8";
      case "tar":
        return "application/x-tar; charset=utf-8";
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "png":
        return "image/png";
      case "gif":
        return "image/gif";
      case "bmp":
        return "image/bmp";
      case "ico":
        return "image/x-icon";
      case "webp":
        return "image/webp";
      case "bmp":
        return "image/bmp";
      case "mp3":
        return "audio/mpeg";
      case "wav":
        return "audio/wav";
      case "mp4":
      case "m4v":
        return "video/mp4";
      case "mov":
        return "video/quicktime";
      case "avi":
        return "video/x-msvideo";
      default:
        if (path.split("/").slice(-1)[0].includes("esm")) {
          return "application/javascript; charset=utf-8";
        }

        return "application/octet-stream";
    }
  };

  const TTL$2 = 5 * 60 * 1000; // 5 分钟

  // 每个路径上一次成功刷新时间（内存级 TTL）
  // SW 进程重启后清空，重启后首次命中缓存会额外触发一次后台刷新
  const lastRefreshAt$1 = new Map();

  // 正在后台刷新中的路径集合，避免同一路径并发重复回源
  const refreshing$1 = new Set();

  /**
   * 后台从 CDN 拉取并覆盖本地缓存
   * @param {string} path - 请求路径
   * @param {string} rePath - 实际 CDN URL
   */
  const refreshInBackground$1 = (path, rePath) => {
    if (refreshing$1.has(path)) return;
    refreshing$1.add(path);

    (async () => {
      try {
        const response = await fetch(rePath, { cache: "no-store" });
        if (!response.ok) return;
        const blob = await response.blob();
        const targetHandle = await getFileHandle({ path, create: true });
        const writeStream = await targetHandle.createWritable();
        await writeStream.write(blob);
        await writeStream.close();
        lastRefreshAt$1.set(path, Date.now());
      } catch (err) {
        console.warn("[gh] background refresh failed:", path, err);
      } finally {
        refreshing$1.delete(path);
      }
    })();
  };

  /**
   * 从 GitHub 仓库获取文件
   * @param {Object} options - 选项
   * @param {string} options.path - 请求路径
   * @param {string} options.originUrl - 原始请求 URL
   * @returns {Promise<Response>} 响应对象
   */
  const handleGitHubRequest = async ({ path }) => {
    // 将 /gh/ 路径转换为 jsDelivr CDN URL
    const rePath = path.replace(/^\/gh\//, "https://cdn.jsdelivr.net/gh/");
    // const rePath = path.replace(/^\/gh\//, "https://cdn.statically.io/gh/");
    // console.log("gh: ", rePath);

    let targetHandle = await getFileHandle({ path }).catch(() => null);

    if (targetHandle) {
      const fileStream = await targetHandle.getFile();
      if (fileStream.size) {
        // 命中缓存：立即返回；仅当内存中无记录或已超过 TTL 时才触发后台刷新
        const cachedAt = lastRefreshAt$1.get(path);
        if (!cachedAt || Date.now() - cachedAt >= TTL$2) {
          refreshInBackground$1(path, rePath);
        }
        return new Response(fileStream, {
          headers: {
            "Content-Type": getContentType(path),
          },
        });
      }
    }

    // 请求实际文件
    const response = await fetch(rePath, {
      cache: "no-store",
    });
    const blob = await response.blob();

    // 写入缓存
    targetHandle = await getFileHandle({ path, create: true });
    const writeStream = await targetHandle.createWritable();
    await writeStream.write(blob);
    await writeStream.close();
    lastRefreshAt$1.set(path, Date.now());

    // 转化为新的 Response 对象
    return new Response(blob, {
      headers: {
        "Content-Type": getContentType(path),
      },
    });
  };

  /**
   * 从本地文件系统获取文件
   * @param {Object} options - 选项
   * @param {string} options.path - 请求路径
   * @param {string} options.originUrl - 原始请求 URL
   * @returns {Promise<Response>} 响应对象
   */
  const handleFileRequest = async ({ path }) => {
    const rePath = path.replace(/^\/\$/, "");

    const fileHandle = await getFileHandle({ path: rePath }).catch(() => null);

    if (fileHandle) {
      const fileStream = await fileHandle.getFile();
      if (fileStream.size) {
        return new Response(fileStream, {
          headers: {
            "Content-Type": getContentType(path),
          },
        });
      }
    }

    return new Response("Not Found", {
      status: 404,
      headers: {
        "Content-Type": getContentType(path),
      },
    });
  };

  const TTL$1 = 5 * 60 * 1000; // 5 分钟

  // 每个路径上一次成功刷新时间（内存级 TTL）
  // SW 进程重启后清空，重启后首次命中缓存会额外触发一次后台刷新
  const lastRefreshAt = new Map();

  // 正在后台刷新中的路径集合，避免同一路径并发重复回源
  const refreshing = new Set();

  /**
   * 后台从 CDN 拉取并覆盖本地缓存
   * @param {string} path - 请求路径
   * @param {string} rePath - 实际 CDN URL
   */
  const refreshInBackground = (path, rePath) => {
    if (refreshing.has(path)) return;
    refreshing.add(path);

    (async () => {
      try {
        const response = await fetch(rePath, { cache: "no-store" });
        if (!response.ok) return;
        const blob = await response.blob();
        const targetHandle = await getFileHandle({ path, create: true });
        const writeStream = await targetHandle.createWritable();
        await writeStream.write(blob);
        await writeStream.close();
        lastRefreshAt.set(path, Date.now());
      } catch (err) {
        console.warn("[npm] background refresh failed:", path, err);
      } finally {
        refreshing.delete(path);
      }
    })();
  };

  /**
   * 从 NPM CDN 获取包文件
   * @param {Object} options - 选项
   * @param {string} options.path - 请求路径
   * @param {string} options.originUrl - 原始请求 URL
   * @returns {Promise<Response>} 响应对象
   */
  const handleNpmRequest = async ({ path }) => {
    // 将 /npm/ 路径转换为 jsDelivr CDN URL
    // 例如: /npm/jquery@3.6.0/dist/jquery.min.js
    // 转换为: https://cdn.jsdelivr.net/npm/jquery@3.6.0/dist/jquery.min.js
    const rePath = path.replace(/^\/npm\//, "https://cdn.jsdelivr.net/npm/");

    let targetHandle = await getFileHandle({ path }).catch(() => null);

    if (targetHandle) {
      const fileStream = await targetHandle.getFile();
      if (fileStream.size) {
        // 命中缓存：立即返回；仅当内存中无记录或已超过 TTL 时才触发后台刷新
        const cachedAt = lastRefreshAt.get(path);
        if (!cachedAt || Date.now() - cachedAt >= TTL$1) {
          refreshInBackground(path, rePath);
        }
        const type = fileStream.type || getContentType(path);
        return new Response(fileStream, {
          headers: {
            "Content-Type": type,
          },
        });
      }
    }

    try {
      // 请求实际文件
      const response = await fetch(rePath);

      // 检查响应状态
      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${rePath}: ${response.status} ${response.statusText}`,
        );
      }

      const blob = await response.blob();

      // 写入缓存
      targetHandle = await getFileHandle({ path, create: true });
      const writeStream = await targetHandle.createWritable();
      await writeStream.write(blob);
      await writeStream.close();
      lastRefreshAt.set(path, Date.now());

      const type = blob.type || getContentType(path);

      // 转化为新的 Response 对象
      return new Response(blob, {
        headers: {
          "Content-Type": type,
        },
      });
    } catch (error) {
      console.error("Error fetching npm package:", error);

      return new Response(`Error fetching npm package: ${error.message}`, {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
  };

  // db相关的操作
  let _handleDB = null;
  const getHandleDB = async () => {
    if (_handleDB) return _handleDB;

    return new Promise((resolve) => {
      const req = indexedDB.open("handles-db", 1);
      req.onupgradeneeded = () =>
        req.result.createObjectStore("handles", { keyPath: "id" });
      req.onsuccess = () => {
        _handleDB = req.result;
        resolve(req.result);
      };
      req.onerror = (e) => {
        _handleDB = null;
      };
      req.onblocked = () => {
        _handleDB = null;
      };
    });
  };

  // 加载指定ID的句柄
  const loadHandle = async (id) => {
    const db = await getHandleDB();
    return new Promise((resolve, reject) => {
      const req = db.transaction("handles").objectStore("handles").get(id);
      req.onsuccess = (e) => {
        const result = e.target.result;
        resolve(result ? result.handle : null);
      };
      req.onerror = () => {
        reject(req.error);
      };
    });
  };

  const handleMountRequest = async ({ path, originUrl }) => {
    let pathname = decodeURIComponent(path);

    if (/\/$/.test(path)) {
      pathname += "index.html";
    }

    const mountedId = pathname.replace(/\/\$mount\-(.+)>.+/, "$1");
    const pathsArr = pathname.split("/").slice(2);

    // 改用直接的 opfs 读取文件方法
    try {
      const rootHandle = await loadHandle(mountedId);

      if (!rootHandle) {
        throw new Error(`Mounted ID ${mountedId} not found`);
      }

      let finalHandle = rootHandle;
      for (let i = 0; i < pathsArr.length; i++) {
        let part = pathsArr[i];
        const isLast = i === pathsArr.length - 1;
        if (isLast) {
          if (part === "") {
            part = "index.html";
          }
          finalHandle = await finalHandle.getFileHandle(part);
        } else {
          finalHandle = await finalHandle.getDirectoryHandle(part);
        }
      }

      const prefix = pathname.split(".").pop();

      return new Response(await finalHandle.getFile(), {
        status: 200,
        headers: {
          "Content-Type": getContentType(prefix),
        },
      });
    } catch (err) {
      return new Response(err.stack || err.toString(), {
        status: 400,
      });
    }
  };

  const handleNosRequest = async ({ path, request, systemConfig }) => {
    const host = location.host;

    // localhost:3002 调试模式直接请求资源，不读取 OPFS 缓存
    if (host === "localhost:3002") {
      return fetch(request);
    }

    // 其他 localhost 端口下，优先将 /nos/ 请求代理到 localhost:3002 的在线资源
    if (/^localhost:/.test(host)) {
      try {
        const newUrl = request.url.replace(/:(\d+)/, ":3002");
        return await fetch(newUrl);
      } catch {
        // localhost:3002 未启动，继续走默认路线
      }
    }

    if (!systemConfig || !systemConfig.mode || systemConfig.mode === "online") {
      // 没有配置数据时，直接返回线上数据
      return fetch(request);
    }

    if (systemConfig.mode === "local") {
      try {
        const rePath = path.replace(/^\/nos\//, systemConfig.nosMapPath + "/");

        let targetHandle = await getFileHandle({ path: rePath }).catch(
          () => null,
        );

        if (targetHandle) {
          const fileStream = await targetHandle.getFile();

          if (fileStream.size) {
            return new Response(fileStream, {
              headers: {
                "Content-Type": getContentType(path),
              },
            });
          }
        }

        return fetch(request);
      } catch (err) {
        return fetch(request);
      }
    }
  };

  const handleNosToolRequest = async ({ request }) => {
    const host = location.host;

    if (host === "localhost:3002") {
      return fetch(request);
    }

    // 返回官方的地址
    const returnOfficial = () => {
      const afterHost = request.url.replace(/^https?:\/\/[^\/]+\//, "");
      return fetch(`https://core.noneos.com/${afterHost}`);
    };

    if (/^localhost:/.test(host)) {
      const newUrl = request.url.replace(/:(\d+)/, ":3002");
      try {
        return await fetch(newUrl);
      } catch {
        return returnOfficial();
      }
    }

    return returnOfficial();
  };

  const getHash = async (data) => {
    if (!globalThis.crypto) {
      // Node.js 环境
      const crypto = await import('crypto');
      if (typeof data === "string") {
        data = new TextEncoder().encode(data);
      } else if (data instanceof Blob) {
        data = await data.arrayBuffer();
      }
      const hash = crypto.createHash("sha256");
      hash.update(Buffer.from(data));
      return hash.digest("hex");
    } else {
      // 浏览器环境
      if (typeof data === "string") {
        data = new TextEncoder().encode(data);
      } else if (data instanceof Blob) {
        data = await data.arrayBuffer();
      }
      const hash = await crypto.subtle.digest("SHA-256", data);
      const hashArray = Array.from(new Uint8Array(hash));
      const hashHex = hashArray
        .map((bytes) => bytes.toString(16).padStart(2, "0"))
        .join("");
      return hashHex;
    }
  };

  const TTL = 5 * 60 * 1000; // 5 分钟
  const META_DIR = "/nos-config/ncomp-meta";

  /**
   * 获取 ncomp 资源的元数据路径
   * @param {string} path - ncomp 资源路径
   * @returns {string} 元数据文件路径
   */
  const getMetaPath = (path) => {
    const relativePath = path.replace(/^\/ncomp\//, "");
    return `${META_DIR}/${relativePath}.json`;
  };

  /**
   * 读取 ncomp 资源的元数据
   * @param {string} path - ncomp 资源路径
   * @returns {Promise<{cachedAt:number,hash:string}|null>} 元数据对象
   */
  const readMeta = async (path) => {
    const targetHandle = await getFileHandle({ path: getMetaPath(path) }).catch(
      () => null,
    );

    if (!targetHandle) {
      return null;
    }

    const fileStream = await targetHandle.getFile();

    if (!fileStream.size) {
      return null;
    }

    try {
      return JSON.parse(await fileStream.text());
    } catch {
      return null;
    }
  };

  /**
   * 写入 ncomp 资源的元数据
   * @param {string} path - ncomp 资源路径
   * @param {Object} meta - 元数据对象
   */
  const writeMeta = async (path, meta) => {
    try {
      const targetHandle = await getFileHandle({
        path: getMetaPath(path),
        create: true,
      });
      const writeStream = await targetHandle.createWritable();
      await writeStream.write(JSON.stringify(meta));
      await writeStream.close();
    } catch (err) {
      console.error("Failed to write ncomp meta:", err);
    }
  };

  /**
   * 从 OPFS 读取缓存
   * @param {string} path - ncomp 资源路径
   * @returns {Promise<File|null>} 缓存文件或 null
   */
  const readFromCache = async (path) => {
    const targetHandle = await getFileHandle({ path }).catch(() => null);

    if (!targetHandle) {
      return null;
    }

    const fileStream = await targetHandle.getFile();

    if (!fileStream.size) {
      return null;
    }

    return fileStream;
  };

  /**
   * 将响应写入 OPFS 缓存
   * @param {string} path - ncomp 资源路径
   * @param {Blob} blob - 响应内容
   */
  const writeToCache = async (path, blob) => {
    try {
      const targetHandle = await getFileHandle({ path, create: true });
      const writeStream = await targetHandle.createWritable();
      await writeStream.write(blob);
      await writeStream.close();
    } catch (err) {
      console.error("Failed to cache ncomp resource:", err);
    }
  };

  /**
   * 创建 Response 对象
   * @param {Blob|File} body - 响应体
   * @param {string} path - ncomp 资源路径
   * @returns {Response} 响应对象
   */
  const createResponse = (body, path) => {
    return new Response(body, {
      headers: {
        "Content-Type": getContentType(path),
      },
    });
  };

  /**
   * 异步更新 OPFS 缓存：对比 hash，有变化则写入，无变化则刷新缓存时间
   * @param {string} path - ncomp 资源路径
   * @param {ArrayBuffer} arrayBuffer - 最新响应内容
   * @param {{cachedAt:number,hash:string}|null} meta - 当前元数据
   */
  const updateCacheAsync = async (path, arrayBuffer, meta) => {
    try {
      const hash = await getHash(arrayBuffer);

      if (!meta || hash !== meta.hash) {
        await writeToCache(path, new Blob([arrayBuffer]));
        await writeMeta(path, { cachedAt: Date.now(), hash });
      } else {
        await writeMeta(path, { ...meta, cachedAt: Date.now() });
      }
    } catch (err) {
      console.error("Failed to update ncomp cache:", err);
    }
  };

  /**
   * 处理 /ncomp/ 资源请求
   * @param {Object} options - 选项
   * @param {string} options.path - 请求路径
   * @param {Request} options.request - 原始请求对象
   * @returns {Promise<Response>} 响应对象
   */
  const handleNcompRequest = async ({ path, request }) => {
    const host = location.host;

    // 请求官方源
    const fetchOfficial = async () => {
      const afterHost = request.url.replace(/^https?:\/\/[^\/]+\//, "");
      return fetch(`https://core.noneos.com/${afterHost}`);
    };

    // 请求当前运行的网站（同域兜底）
    const fetchCurrent = async () => {
      return fetch(new URL(path, location.origin).href);
    };

    // 从 OPFS 读取缓存（带元数据）
    const readCacheWithMeta = async () => {
      const [cachedFile, meta] = await Promise.all([
        readFromCache(path),
        readMeta(path),
      ]);
      return { cachedFile, meta };
    };

    // localhost 环境下，优先将 /ncomp/ 请求代理到 localhost:3002 的在线资源
    if (/^localhost:/.test(host)) {
      const newUrl = request.url.replace(/:(\d+)/, ":3002");

      try {
        const response = await fetch(newUrl);

        if (!response.ok) {
          throw new Error(
            `Failed to fetch ${newUrl}: ${response.status} ${response.statusText}`,
          );
        }

        const arrayBuffer = await response.arrayBuffer();
        const { meta } = await readCacheWithMeta();

        // localhost 下需要确保缓存可靠写入，以便 3002 不可用时能回退
        await updateCacheAsync(path, arrayBuffer, meta);

        return createResponse(new Blob([arrayBuffer]), path);
      } catch {
        // localhost:3002 未启动或请求失败，继续走缓存 / 官方源路线
      }
    }

    const { cachedFile, meta } = await readCacheWithMeta();

    // 缓存有效（未过期且有内容）：直接返回
    if (cachedFile && meta && Date.now() - meta.cachedAt < TTL) {
      return createResponse(cachedFile, path);
    }

    // 缓存过期或不存在：请求网络，立刻返回最新数据，后台异步更新 OPFS
    try {
      const response = await fetchOfficial();

      if (!response.ok) {
        throw new Error(
          `Failed to fetch official ncomp resource: ${response.status} ${response.statusText}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();

      updateCacheAsync(path, arrayBuffer, meta);

      return createResponse(new Blob([arrayBuffer]), path);
    } catch (error) {
      // localhost 环境下，官方源失败时尝试直接请求当前运行的网站（同域兜底）
      if (/^localhost:/.test(host)) {
        try {
          const currentResponse = await fetchCurrent();

          if (currentResponse.ok) {
            const arrayBuffer = await currentResponse.arrayBuffer();

            updateCacheAsync(path, arrayBuffer, meta);

            return createResponse(new Blob([arrayBuffer]), path);
          }
        } catch {
          // 当前网站也失败，继续走旧缓存兜底
        }
      }

      // 网络失败时回退到旧缓存
      if (cachedFile) {
        return createResponse(cachedFile, path);
      }

      console.error("Error fetching ncomp resource:", error);

      return new Response(`Error fetching ncomp resource: ${error.message}`, {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
  };

  // 当前系统的配置信息
  // let systemConfig = {"version":"4.0.0","mode":"online","nosMapPath":"nos-4.0.0"};
  let systemConfig = {};

  const NONEOS_CORE_VERSION = "noneos-core@4.2.0";

  self.addEventListener("fetch", (event) => {
    const { request } = event;
    const { pathname, hostname } = new URL(request.url);

    const coreHostName =
      globalThis?.SERVER_OPTIONS?.coreHostName || "core.noneos.com";

    if (hostname !== location.hostname && hostname !== coreHostName) {
      return;
    }

    if (pathname === "/__config") {
      return event.respondWith(reloadSystemConfig());
    }

    try {
      if (/^\/nos-tool\//.test(pathname)) {
        return event.respondWith(
          handleNosToolRequest({
            path: pathname,
            request,
            systemConfig,
          }),
        );
      }

      if (/^\/ncomp\//.test(pathname)) {
        return event.respondWith(
          handleNcompRequest({
            path: pathname,
            request,
            systemConfig,
          }),
        );
      }

      if (/^\/nos\//.test(pathname)) {
        return event.respondWith(
          handleNosRequest({
            path: pathname,
            request,
            systemConfig,
          }),
        );
      }

      if (/^\/gh\//.test(pathname)) {
        // 从 GitHub 仓库获取文件
        return event.respondWith(
          handleGitHubRequest({
            path: pathname,
            originUrl: request.url,
            systemConfig,
          }),
        );
      }

      if (/^\/npm\//.test(pathname)) {
        // 从 NPM CDN 获取包文件
        return event.respondWith(
          handleNpmRequest({
            path: pathname,
            originUrl: request.url,
            systemConfig,
          }),
        );
      }

      if (/^\/\$mount-/.test(pathname)) {
        return event.respondWith(
          handleMountRequest({
            path: pathname,
            originUrl: request.url,
            systemConfig,
          }),
        );
      }

      if (/^\/\$/.test(pathname)) {
        return event.respondWith(
          handleFileRequest({
            path: pathname,
            originUrl: request.url,
            systemConfig,
          }),
        );
      }
    } catch (err) {
      return new Response(err.stack || err.toString(), {
        status: 400,
      });
    }

    // if (/^\/_/.test(pathname)) {
    //   // 隐藏目录开头的，属于本地文件，无需代理
    //   return;
    // }
  });

  self.addEventListener("install", () => {
    self.skipWaiting();
    console.log("NoneOS installation successful");
  });

  self.addEventListener("activate", () => {
    self.clients.claim();
    console.log("NoneOS server activation successful");

    setTimeout(() => {
      reloadSystemConfig();
    }, 1000);
  });

  const reloadSystemConfig = async () => {
    try {
      const rootHandle = await navigator.storage.getDirectory();
      const configHandle = await rootHandle.getDirectoryHandle("nos-config");
      const configFileHandle = await configHandle.getFileHandle("system.json");
      const file = await configFileHandle.getFile();
      const content = await file.text();

      if (content) {
        systemConfig = JSON.parse(content);
      }

      return new Response(
        JSON.stringify({
          serviceWorkerVersion: NONEOS_CORE_VERSION.replace("noneos-core@", ""),
          systemConfig,
        }),
      );
    } catch (err) {
      console.error("Reload system config failed:", err);
      return new Response("Reload failed: " + (err.message || err), {
        status: 500,
      });
    }
  };

  reloadSystemConfig();

})();
//# sourceMappingURL=dist.js.map
