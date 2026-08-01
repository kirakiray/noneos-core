/* noneos-core version: 4.3.0 */
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

  /**
   * 统一的 SWR（Stale-While-Revalidate）资源处理器。
   *
   * 策略：
   * - 缓存命中 & TTL 内   → 直接返回缓存
   * - 缓存命中 & TTL 过期 → 立即返回缓存，后台刷新
   * - 缓存未命中          → 同步网络请求，写盘后返回
   * - 网络优先模式        → 每次都先请求网络，失败时回退缓存
   *
   * 内存级 TTL：仅保留最近 5 分钟内活跃的路径。SW 进程重启后清空。
   */

  const TTL = 5 * 60 * 1000;

  // 所有 handler 共用一份状态
  const lastRefreshAt = new Map(); // path -> 最近一次成功刷新时间
  const refreshing = new Set(); // 正在后台刷新的路径，用于去重

  /**
   * 检查是否需要刷新；顺带回收过期条目
   */
  const shouldRefresh = (path) => {
    const t = lastRefreshAt.get(path);
    if (!t) return true;
    if (Date.now() - t >= TTL) {
      lastRefreshAt.delete(path);
      return true;
    }
    return false;
  };

  /**
   * 按顺序尝试多个源，返回第一个成功的 Blob
   */
  const fetchFromSources = async (sources) => {
    let lastError;
    for (const url of sources) {
      try {
        const response = await fetch(url, { cache: "no-store" });
        if (!response.ok) {
          lastError = new Error(`${url}: ${response.status} ${response.statusText}`);
          continue;
        }
        return await response.blob();
      } catch (err) {
        lastError = err;
      }
    }
    throw lastError || new Error("No source available");
  };

  /**
   * 将 blob 写入 OPFS
   */
  const writeToCache = async (path, blob) => {
    const targetHandle = await getFileHandle({ path, create: true });
    const writeStream = await targetHandle.createWritable();
    await writeStream.write(blob);
    await writeStream.close();
  };

  /**
   * 后台异步刷新（离线守卫 + 去重）
   */
  const refreshInBackground = (path, sources, tag) => {
    if (!navigator.onLine) return;
    if (refreshing.has(path)) return;
    refreshing.add(path);

    (async () => {
      try {
        const blob = await fetchFromSources(sources);
        await writeToCache(path, blob);
        lastRefreshAt.set(path, Date.now());
      } catch (err) {
        console.warn(`[${tag}] background refresh failed:`, path, err);
      } finally {
        refreshing.delete(path);
      }
    })();
  };

  /**
   * 读取 OPFS 缓存
   * @returns {Promise<File|null>}
   */
  const readCache = async (path) => {
    const targetHandle = await getFileHandle({ path }).catch(() => null);
    if (!targetHandle) return null;
    const file = await targetHandle.getFile();
    return file.size ? file : null;
  };

  const okResponse = (body, path) =>
    new Response(body, { headers: { "Content-Type": getContentType(path) } });

  const errResponse = (tag, err) =>
    new Response(`Error fetching ${tag} resource: ${err.message || err}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });

  /**
   * 创建统一的 SWR handler
   *
   * @param {Object} opts
   * @param {string} opts.tag                    日志标签
   * @param {(ctx: {path: string, request: Request}) => string[]} opts.resolveSources
   *        返回按优先级排列的候选源 URL 数组
   * @param {(ctx: {path: string, request: Request}) => boolean} [opts.networkFirstWhen]
   *        返回 true 时改用"网络优先"模式（如 localhost dev）
   */
  const createHandler = ({ tag, resolveSources, networkFirstWhen }) => {
    return async ({ path, request }) => {
      const ctx = { path, request };
      const sources = resolveSources(ctx);
      const networkFirst = networkFirstWhen ? networkFirstWhen(ctx) : false;

      // 网络优先：dev 模式下始终尝试网络，失败回退缓存
      if (networkFirst) {
        try {
          const blob = await fetchFromSources(sources);
          await writeToCache(path, blob);
          lastRefreshAt.set(path, Date.now());
          return okResponse(blob, path);
        } catch {
          const cached = await readCache(path);
          if (cached) return okResponse(cached, path);
          // 全部失败，落到下面的错误处理
        }
      }

      // SWR：缓存优先，过期后台刷新
      const cached = await readCache(path);
      if (cached) {
        if (shouldRefresh(path)) refreshInBackground(path, sources, tag);
        return okResponse(cached, path);
      }

      // 缓存未命中：同步网络
      try {
        const blob = await fetchFromSources(sources);
        await writeToCache(path, blob);
        lastRefreshAt.set(path, Date.now());
        return okResponse(blob, path);
      } catch (err) {
        console.error(`[${tag}] fetch failed:`, err);
        return errResponse(tag, err);
      }
    };
  };

  // ---------- 具体 handler ----------

  /**
   * /gh/{user}/{repo}@{tag}/path → https://cdn.jsdelivr.net/gh/{user}/{repo}@{tag}/path
   */
  const handleGitHubRequest = createHandler({
    tag: "gh",
    resolveSources: ({ path }) => [
      path.replace(/^\/gh\//, "https://cdn.jsdelivr.net/gh/"),
    ],
  });

  /**
   * /npm/{package}@{version}/path → https://cdn.jsdelivr.net/npm/{package}@{version}/path
   */
  const handleNpmRequest = createHandler({
    tag: "npm",
    resolveSources: ({ path }) => [
      path.replace(/^\/npm\//, "https://cdn.jsdelivr.net/npm/"),
    ],
  });

  /**
   * /ncomp/xxx
   * - localhost dev：优先 localhost:3002 → 官方源 → 同域兜底（网络优先）
   * - 生产环境：直接走官方源（SWR）
   */
  const handleNcompRequest = createHandler({
    tag: "ncomp",
    networkFirstWhen: () => /^localhost:/.test(location.host),
    resolveSources: ({ path, request }) => {
      const afterHost = request.url.replace(/^https?:\/\/[^\/]+\//, "");
      const isDev = /^localhost:/.test(location.host);
      return [
        isDev ? request.url.replace(/:(\d+)/, ":3002") : null,
        `https://core.noneos.com/${afterHost}`,
        isDev ? new URL(path, location.origin).href : null,
      ].filter(Boolean);
    },
  });

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

  /**
   * 宿主项目离线缓存处理器
   *
   * 允许使用 noneos-core 的项目通过 manifest 文件（host-cache.json）
   * 声明需要离线缓存的文件列表，SW 会在后台预缓存这些文件，
   * 并在 fetch 时优先从 OPFS 缓存返回。
   *
   * OPFS 结构:
   *   host-cache/
   *     manifest.json    # 持久化的 manifest
   *     files/           # 缓存文件，保持原始路径结构
   *       index.html
   *       apps/main/home.html
   *       ...
   */

  const HOST_CACHE_DIR = "host-cache";
  const MANIFEST_FILE = "manifest.json";
  const FILES_DIR = "files";

  // 内存状态
  let hostManifest = null; // { name, version, files: [] }
  let fileSet = null; // Set<string>，快速查找
  let precaching = false; // 是否正在预缓存

  // --- 配置 ---

  const getManifestPath = () => {
    if (
      typeof globalThis.HOST_CACHE_CONFIG === "object" &&
      globalThis.HOST_CACHE_CONFIG?.manifestPath
    ) {
      return globalThis.HOST_CACHE_CONFIG.manifestPath;
    }
    return "/host-cache.json";
  };

  // --- Manifest 持久化 ---

  const loadManifestFromOPFS = async () => {
    try {
      const handle = await getFileHandle({
        path: `${HOST_CACHE_DIR}/${MANIFEST_FILE}`,
      });
      const file = await handle.getFile();
      const text = await file.text();
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  };

  const saveManifestToOPFS = async (manifest) => {
    const handle = await getFileHandle({
      path: `${HOST_CACHE_DIR}/${MANIFEST_FILE}`,
      create: true,
    });
    const stream = await handle.createWritable();
    await stream.write(JSON.stringify(manifest, null, 2));
    await stream.close();
  };

  // --- 目录操作工具 ---

  const getDirHandleByPath = async (dirPath, { create } = {}) => {
    const rootHandle = await getRootDirectory();
    const parts = dirPath.split("/").filter(Boolean);
    let handle = rootHandle;
    for (const part of parts) {
      handle = await handle.getDirectoryHandle(part, { create });
    }
    return handle;
  };

  const deleteCachedFile = async (filePath) => {
    const opfsPath = `${HOST_CACHE_DIR}/${FILES_DIR}/${filePath}`;
    const parts = opfsPath.split("/");
    const fileName = parts.pop();
    const dirPath = parts.join("/");

    const dirHandle = await getDirHandleByPath(dirPath).catch(() => null);
    if (dirHandle) {
      await dirHandle.removeEntry(fileName).catch(() => {});
    }
  };

  // --- 预缓存 ---

  const broadcast = (data) => {
    self.clients.matchAll().then((clients) => {
      for (const client of clients) {
        client.postMessage(data);
      }
    });
  };

  const precacheFile = async (filePath) => {
    const url = filePath.startsWith("/") ? filePath : "/" + filePath;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) {
      throw new Error(`${filePath}: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();

    const opfsPath = `${HOST_CACHE_DIR}/${FILES_DIR}/${filePath}`;
    const handle = await getFileHandle({ path: opfsPath, create: true });
    const stream = await handle.createWritable();
    await stream.write(blob);
    await stream.close();
  };

  const precacheFiles = async (manifest) => {
    const files = manifest.files || [];
    let downloaded = 0;
    let failed = 0;

    for (const filePath of files) {
      try {
        await precacheFile(filePath);
        downloaded++;
      } catch {
        failed++;
      }
      broadcast({
        type: "host-cache-progress",
        total: files.length,
        downloaded,
        failed,
      });
    }

    return { downloaded, failed, total: files.length };
  };

  // --- 更新流程 ---

  const updateHostCache = async (newManifest) => {
    if (precaching) {
      return { ok: false, reason: "already-precaching" };
    }
    precaching = true;

    try {
      const oldFiles = fileSet || new Set();
      const newFiles = new Set(newManifest.files || []);

      // 立即更新内存状态（fetch 拦截可以生效）
      hostManifest = newManifest;
      fileSet = newFiles;

      // 删除不再需要的旧文件
      for (const filePath of oldFiles) {
        if (!newFiles.has(filePath)) {
          await deleteCachedFile(filePath).catch(() => {});
        }
      }

      // 预缓存所有文件（覆盖已有文件，确保内容最新）
      const result = await precacheFiles(newManifest);

      // 预缓存完成后持久化 manifest
      await saveManifestToOPFS(newManifest);

      broadcast({ type: "host-cache-complete", ...result });

      return { ok: true, ...result };
    } finally {
      precaching = false;
    }
  };

  // --- 初始化 ---

  const initHostCache = async () => {
    // 先从 OPFS 加载持久化的 manifest
    hostManifest = await loadManifestFromOPFS();
    if (hostManifest) {
      fileSet = new Set(hostManifest.files || []);
    }

    // 尝试从网络拉取最新 manifest
    const manifestPath = getManifestPath();
    try {
      const response = await fetch(manifestPath, { cache: "no-store" });
      if (response.ok) {
        const latest = await response.json();
        if (!hostManifest || latest.version !== hostManifest.version) {
          // 版本变化或首次加载，触发预缓存
          await updateHostCache(latest);
        } else {
          // 版本相同，仅更新内存状态
          hostManifest = latest;
          fileSet = new Set(latest.files || []);
        }
      }
    } catch {
      // 离线或 manifest 不可用，使用 OPFS 中的持久化版本
    }
  };

  // --- Fetch 拦截 ---

  /**
   * 同步检查路径是否在 host-cache 缓存列表中。
   * 用于 main.js 在调用 respondWith 之前做快速判断。
   */
  const isHostCachedFile = (path) => {
    if (!fileSet) return false;
    const filePath = path.replace(/^\//, "");
    if (!fileSet.has(filePath)) return false;
    // manifest 文件本身不走缓存，始终从网络获取
    if (path === getManifestPath()) return false;
    return true;
  };

  /**
   * 处理 host-cache 文件请求。
   * 优先返回 OPFS 缓存，未命中时回退网络并写入缓存。
   */
  const handleHostCacheRequest = async ({ path, request }) => {
    if (request.method !== "GET") return null;

    const filePath = path.replace(/^\//, "");
    if (!fileSet || !fileSet.has(filePath)) return null;

    // 尝试从 OPFS 缓存读取
    const opfsPath = `${HOST_CACHE_DIR}/${FILES_DIR}/${filePath}`;
    const handle = await getFileHandle({ path: opfsPath }).catch(() => null);

    if (handle) {
      const file = await handle.getFile();
      if (file.size) {
        return new Response(file, {
          headers: { "Content-Type": getContentType(path) },
        });
      }
    }

    // 缓存未命中：回退网络并写入缓存
    try {
      const response = await fetch(request);
      if (response.ok) {
        const blob = await response.blob();
        const cacheHandle = await getFileHandle({
          path: opfsPath,
          create: true,
        });
        const stream = await cacheHandle.createWritable();
        await stream.write(blob);
        await stream.close();
        return new Response(blob, {
          headers: { "Content-Type": getContentType(path) },
        });
      }
      return response;
    } catch {
      return null;
    }
  };

  // --- 状态查询路由 ---

  const handleHostCacheStatus = () => {
    return new Response(
      JSON.stringify({
        name: hostManifest?.name || null,
        version: hostManifest?.version || null,
        fileCount: hostManifest?.files?.length || 0,
        precaching,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  };

  // --- 触发更新路由 ---

  /**
   * 触发 host-cache 更新。
   * SW 自行从网络拉取最新 manifest，版本变化时才执行预缓存。
   */
  const triggerHostCacheUpdate = async () => {
    let manifest;
    try {
      const response = await fetch(getManifestPath(), { cache: "no-store" });
      if (response.ok) {
        manifest = await response.json();
      }
    } catch {}

    if (!manifest) {
      return new Response(
        JSON.stringify({ ok: false, reason: "manifest-not-available" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // 版本相同，无需更新
    if (hostManifest && manifest.version === hostManifest.version) {
      return new Response(
        JSON.stringify({ ok: true, reason: "version-up-to-date", version: manifest.version }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const result = await updateHostCache(manifest);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  };

  // --- postMessage 处理 ---

  const handleHostCacheMessage = async (data) => {
    if (data?.type !== "host-cache-update") return null;

    let manifest = data.manifest;
    if (!manifest) {
      // 前端未提供 manifest，SW 自行拉取
      try {
        const response = await fetch(getManifestPath(), { cache: "no-store" });
        if (response.ok) {
          manifest = await response.json();
        }
      } catch {}
    }

    if (!manifest) {
      return { ok: false, reason: "manifest-not-available" };
    }

    // 版本相同，无需更新
    if (hostManifest && manifest.version === hostManifest.version) {
      return { ok: true, reason: "version-up-to-date", version: manifest.version };
    }

    return await updateHostCache(manifest);
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

  // 当前系统的配置信息
  // let systemConfig = {"version":"4.0.0","mode":"online","nosMapPath":"nos-4.0.0"};
  let systemConfig = {};

  const NONEOS_CORE_VERSION = "noneos-core@4.2.9";

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

    if (pathname === "/__host-cache" && globalThis.HOST_CACHE_CONFIG) {
      return event.respondWith(handleHostCacheStatus());
    }

    if (pathname === "/__update-host-cache" && globalThis.HOST_CACHE_CONFIG) {
      return event.respondWith(triggerHostCacheUpdate());
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

      // 宿主项目缓存 fallback：不匹配 noneos-core 路由的同域 GET 请求
      if (
        globalThis.HOST_CACHE_CONFIG &&
        request.method === "GET" &&
        isHostCachedFile(pathname)
      ) {
        return event.respondWith(
          handleHostCacheRequest({ path: pathname, request }),
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

  // 宿主项目缓存更新消息处理
  self.addEventListener("message", (event) => {
    if (!globalThis.HOST_CACHE_CONFIG) return;
    if (event.data?.type !== "host-cache-update") return;

    handleHostCacheMessage(event.data).then((result) => {
      event.source?.postMessage({
        type: "host-cache-update-result",
        ...result,
      });
    });
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

  // 初始化宿主项目缓存（仅在宿主项目配置了 HOST_CACHE_CONFIG 时生效）
  if (globalThis.HOST_CACHE_CONFIG) {
    initHostCache();
  }

})();
//# sourceMappingURL=dist.js.map
