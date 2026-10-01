/* noneos-core version: 4.9.0 */
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
   * /nos-lib/xxx（nos 官方在线库：公共组件等，不进 nos.tgz 签名包）
   * - localhost dev：优先 localhost:3002 → 官方源 → 同域兜底（网络优先）
   * - 生产环境：直接走官方源（SWR）
   * 旧前缀 /ncomp/、/nos-tool/comps/ 由 main.js 归一化为 /nos-lib/ 后进入，
   * OPFS 缓存键即归一化后的 path（落在 nos-lib/ 目录）。
   */
  const handleNosLibRequest = createHandler({
    tag: "nos-lib",
    networkFirstWhen: () => /^localhost:/.test(location.host),
    resolveSources: ({ path }) => {
      const isDev = /^localhost:/.test(location.host);
      return [
        isDev ? new URL(path, "http://localhost:3002").href : null,
        `https://core.noneos.com${path}`,
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

  /**
   * 官方源代理（/nos-tool/ 工具集与 /nos-lib/_install/ 共用，不读写缓存）：
   * - localhost:3002：直接透传本地静态服务器
   * - 其他 localhost 端口：优先代理到 3002，失败回退官方源
   * - 生产环境：直接回源官方
   *
   * path 由 main.js 归一化为仓库物理路径（旧前缀别名也先归一化），
   * 保证回源目标始终是新路径；旧 URL 由托管层 301 兜底。
   */
  const handleOfficialSourceRequest = async ({ path, request }) => {
    const host = location.host;

    // 不能把 fetch 事件的整体 request 作为 init 传给 fetch(url, request)：
    // 导航请求的 mode 是 "navigate"，二次构造会直接抛 TypeError，
    // 因此只转发方法与头
    const fetchOptions = { method: request.method, headers: request.headers };

    if (host === "localhost:3002") {
      return fetch(new URL(path, location.origin).href, fetchOptions);
    }

    const returnOfficial = () => fetch(`https://core.noneos.com${path}`);

    if (/^localhost:/.test(host)) {
      // 依次尝试：3002 开发服务器 → 同域（如 30028 正式部署端口、静态服务器）→ 官方源
      // fetch 对 404 等 HTTP 错误状态不会 throw，候选源返回非 ok 响应时
      // 必须视为失败继续回退，否则文件缺失时永远到不了官方源
      try {
        const res = await fetch(new URL(path, "http://localhost:3002").href, fetchOptions);
        if (res.ok) {
          return res;
        }
      } catch {
        // 3002 未启动
      }
      try {
        const res = await fetch(new URL(path, location.origin).href, fetchOptions);
        if (res.ok) {
          return res;
        }
      } catch {
        // 同域也没有该文件
      }
      return returnOfficial();
    }

    return returnOfficial();
  };

  // 当前系统的配置信息
  // let systemConfig = {"version":"4.0.0","mode":"online","nosMapPath":"nos-4.0.0"};
  let systemConfig = {};

  // 配置就绪 Promise：systemConfig 供各路由处理器消费，
  // SW 冷启动时首个请求可能早于 OPFS 读取完成。
  let configReadyPromise = null;

  // 读取 OPFS 中的系统配置；失败（如配置文件不存在）时
  // 保留当前配置（初始为空对象）并正常 resolve，绝不 reject 或挂起
  const loadSystemConfig = async () => {
    try {
      const rootHandle = await navigator.storage.getDirectory();

      // 新版布局：nos/nos-config/system.json；兼容旧版安装的根目录 nos-config/
      let configFileHandle;
      try {
        configFileHandle = await rootHandle
          .getDirectoryHandle("nos")
          .then((dir) => dir.getDirectoryHandle("nos-config"))
          .then((dir) => dir.getFileHandle("system.json"));
      } catch {
        configFileHandle = await rootHandle
          .getDirectoryHandle("nos-config")
          .then((dir) => dir.getFileHandle("system.json"));
      }

      const file = await configFileHandle.getFile();
      const content = await file.text();

      if (content) {
        systemConfig = JSON.parse(content);
      }
    } catch (err) {
      console.error("Reload system config failed:", err);
    }
  };

  // 确保配置已加载（复用进行中的加载，避免并发重复读取）
  const ensureConfigReady = () => {
    if (!configReadyPromise) {
      configReadyPromise = loadSystemConfig();
    }
    return configReadyPromise;
  };

  const NONEOS_CORE_VERSION = "noneos-core@4.9.0";

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
      // /nos-lib/_install/ 为安装引导（必须实时回源，不缓存）；
      // 旧前缀 /nos-tool/_install/ 归一化后走同一处理器（兼容已部署的第三方页面）
      if (/^\/nos-lib\/_install\//.test(pathname) || /^\/nos-tool\/_install\//.test(pathname)) {
        return event.respondWith(
          handleOfficialSourceRequest({
            path: pathname.replace(/^\/nos-tool\/_install\//, "/nos-lib/_install/"),
            request,
            systemConfig,
          }),
        );
      }

      // /nos-lib/ 官方在线库（SWR 缓存）；
      // 旧前缀 /ncomp/、/nos-tool/comps/ 归一化到新路径（兼容旧引用，缓存键统一为新路径）
      if (/^\/nos-lib\//.test(pathname) || /^\/ncomp\//.test(pathname) || /^\/nos-tool\/comps\//.test(pathname)) {
        const libPath = pathname
          .replace(/^\/ncomp\//, "/nos-lib/")
          .replace(/^\/nos-tool\/comps\//, "/nos-lib/nos-version/");
        return event.respondWith(
          handleNosLibRequest({
            path: libPath,
            request,
            systemConfig,
          }),
        );
      }

      if (/^\/nos-tool\//.test(pathname)) {
        return event.respondWith(
          handleOfficialSourceRequest({
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

      // 宿主项目的自有文件缓存不属于 noneos-core 职责，
      // 未匹配路由的同域请求直接放行网络（宿主可在自己的 fetch 监听中处理）
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
    // 预热配置加载，把冷启动首个导航的等待压到最低
    ensureConfigReady();
    console.log("NoneOS installation successful");
  });

  self.addEventListener("activate", () => {
    self.clients.claim();
    ensureConfigReady();
    console.log("NoneOS server activation successful");
  });

  const reloadSystemConfig = async () => {
    // 重建加载 Promise：/__config 触发的重载结果对后续请求立即可见
    configReadyPromise = loadSystemConfig();
    await configReadyPromise;

    return new Response(
      JSON.stringify({
        serviceWorkerVersion: NONEOS_CORE_VERSION.replace("noneos-core@", ""),
        systemConfig,
      }),
    );
  };

  // 模块加载即预热配置，尽早填好 systemConfig
  ensureConfigReady();

})();
//# sourceMappingURL=dist.js.map
