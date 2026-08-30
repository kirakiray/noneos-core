/* noneos-core version: 4.5.4 */
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
  const lastRefreshAt$1 = new Map(); // path -> 最近一次成功刷新时间
  const refreshing$1 = new Set(); // 正在后台刷新的路径，用于去重

  /**
   * 检查是否需要刷新；顺带回收过期条目
   */
  const shouldRefresh$1 = (path) => {
    const t = lastRefreshAt$1.get(path);
    if (!t) return true;
    if (Date.now() - t >= TTL) {
      lastRefreshAt$1.delete(path);
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
  const refreshInBackground$1 = (path, sources, tag) => {
    if (!navigator.onLine) return;
    if (refreshing$1.has(path)) return;
    refreshing$1.add(path);

    (async () => {
      try {
        const blob = await fetchFromSources(sources);
        await writeToCache(path, blob);
        lastRefreshAt$1.set(path, Date.now());
      } catch (err) {
        console.warn(`[${tag}] background refresh failed:`, path, err);
      } finally {
        refreshing$1.delete(path);
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
          lastRefreshAt$1.set(path, Date.now());
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
        if (shouldRefresh$1(path)) refreshInBackground$1(path, sources, tag);
        return okResponse(cached, path);
      }

      // 缓存未命中：同步网络
      try {
        const blob = await fetchFromSources(sources);
        await writeToCache(path, blob);
        lastRefreshAt$1.set(path, Date.now());
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

  // dev-bridge：开发调试模式下的 HTML 脚本注入
  //
  // 由 systemConfig.devBridge 配置驱动（nos-config/system.json）：
  //   {
  //     "devBridge": {
  //       "script": "http://127.0.0.1:PORT/client.js",  // 非空才启用注入
  //       "async": true,                                 // 缺省 false（同步插入，尽早执行）
  //       "banner": true                                 // 缺省 true，页面顶部警告横幅
  //     }
  //   }
  //
  // 行为约定：
  // - 仅对顶层 HTML 导航（GET + destination === "document"）注入；
  // - 响应 content-type 含 text/html 且文档带 <head> 标签才注入，
  //   无 <head> 的文档（如 ofa.js 页面/组件模块）直接原样返回；
  // - 注入位置为 <head> 开标签之后（head 内最前），顺序为：
  //   ① 防篡改警告横幅守卫脚本（同步内联，先于页面所有脚本执行）
  //   ② 配置的 dev bridge script
  // - 横幅被页面脚本移除/隐藏时，整页替换为「疑似恶意程序」警告；
  // - 任何读取/解析失败都原样返回原始响应，绝不因注入失败破坏页面。

  // 注入到每个页面的守卫脚本：显示开发模式警告横幅，并被防篡改保护。
  // ⚠️ 注意：本脚本写在模板字符串内，正则等处的反斜杠必须双写（\\s、\\d），
  // 否则会被模板字符串转义吞掉，生成非法正则导致整个守卫脚本崩溃。
  // 说明：注入位置在 <head> 最前，本脚本先于页面所有脚本执行，因此闭包内
  // 固化的 MutationObserver/setInterval 引用无法被页面脚本替换；防御是
  // 尽力而为（best-effort）级别，而非绝对不可绕过。
  const BANNER_GUARD_SCRIPT = `
(() => {
  if (self.__noneosDevBanner) return;
  self.__noneosDevBanner = true;

  const Observer = MutationObserver;
  const ticker = setInterval;

  // 多语言文案：跟随浏览器语言（zh* → 中文，其余 → 英文）
  const isZh = (navigator.language || "en").toLowerCase().startsWith("zh");
  const i18n = isZh
    ? {
        banner:
          "⚠️ 开发者模式已启用（dev-bridge）— 页面被注入调试脚本，请勿输入敏感数据",
        alarm:
          "⚠️ 警告：此页面移除了开发者模式横幅，疑似恶意程序，请立即停止操作并关闭本页。",
      }
    : {
        banner:
          "⚠️ Developer mode enabled (dev-bridge) — debug scripts are injected into this page. Do not enter sensitive data.",
        alarm:
          "⚠️ WARNING: this page removed the developer-mode banner and may be malicious. Stop what you are doing and close this page.",
      };

  const BANNER_ID = "__noneos-dev-banner";
  const ALARM_ID = "__noneos-dev-alarm";
  const POS_KEY = "__noneos-dev-banner-pos";
  const MAX_Z = "2147483647";

  // 恢复上次拖拽保存的位置（跨页面、跨会话记忆）
  const restorePos = (el) => {
    try {
      const saved = JSON.parse(localStorage.getItem(POS_KEY) || "null");
      if (saved && typeof saved.left === "number" && typeof saved.top === "number") {
        el.style.left = Math.max(0, Math.min(saved.left, innerWidth - 40)) + "px";
        el.style.top = Math.max(0, Math.min(saved.top, innerHeight - 20)) + "px";
        el.style.right = "auto";
      }
    } catch {}
  };

  // 拖拽支持：横幅可被拖到不遮挡关键内容的位置，位置持久化到 localStorage
  const makeDraggable = (el) => {
    if (el.__noneosDraggable) return;
    el.__noneosDraggable = true;
    el.style.cursor = "move";
    el.style.userSelect = "none";
    el.style.touchAction = "none";

    let startX = 0, startY = 0, startLeft = 0, startTop = 0;

    const onMove = (e) => {
      const left = Math.max(
        0,
        Math.min(startLeft + e.clientX - startX, innerWidth - 40)
      );
      const top = Math.max(
        0,
        Math.min(startTop + e.clientY - startY, innerHeight - 20)
      );
      el.style.left = left + "px";
      el.style.top = top + "px";
      el.style.right = "auto";
    };

    const onEnd = () => {
      removeEventListener("pointermove", onMove);
      removeEventListener("pointerup", onEnd);
      try {
        localStorage.setItem(
          POS_KEY,
          JSON.stringify({ left: el.offsetLeft, top: el.offsetTop })
        );
      } catch {}
    };

    el.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = el.offsetLeft;
      startTop = el.offsetTop;
      addEventListener("pointermove", onMove);
      addEventListener("pointerup", onEnd);
    });
  };

  const createBanner = () => {
    const el = document.createElement("div");
    el.id = BANNER_ID;
    el.textContent = i18n.banner;
    Object.assign(el.style, {
      position: "fixed",
      top: "0",
      left: "0",
      right: "0",
      zIndex: MAX_Z,
      padding: "6px 12px",
      textAlign: "center",
      fontWeight: "600",
      fontSize: "13px",
      lineHeight: "1.5",
      color: "#6b4300",
      background: "rgba(255, 193, 7, 0.8)",
    });
    makeDraggable(el);
    restorePos(el);
    return el;
  };

  const getBanner = () => document.getElementById(BANNER_ID);

  const ensureBanner = () => {
    let el = getBanner();
    if (!el) {
      el = createBanner();
      (document.documentElement || document).appendChild(el);
    }
    return el;
  };

  // 可见性判断：综合样式与几何信息，覆盖常见的「不删除但隐藏」手段 ——
  // display/visibility/低透明度、filter 透明或大模糊、clip-path 裁剪、
  // transform 缩放为 0 或移出视口、宽高压 0、背景与文字同时全透明。
  const alphaOf = (color) => {
    const m = /rgba?\\([^)]*,\\s*([\\d.]+)\\s*\\)|rgba?\\(([^)]*)\\)/.exec(color || "");
    if (!m) return 1;
    const val = m[1] !== undefined ? m[1] : (m[2] || "").split(",").pop();
    return parseFloat(val);
  };

  const isBannerVisible = () => {
    const el = getBanner();
    if (!el || !el.isConnected) return false;
    const style = self.getComputedStyle(el);
    if (
      style.display === "none" ||
      style.visibility === "hidden" ||
      parseFloat(style.opacity || "1") < 0.3
    ) {
      return false;
    }
    // filter：整体透明度过低或模糊到不可读
    const filter = style.filter || "";
    const fOpacity = /opacity\\(\\s*([\\d.]+)%?\\s*\\)/.exec(filter);
    if (fOpacity && parseFloat(fOpacity[1]) < 0.3) return false;
    const fBlur = /blur\\(\\s*([\\d.]+)px\\s*\\)/.exec(filter);
    if (fBlur && parseFloat(fBlur[1]) >= 5) return false;
    // clip-path：整圆/整 inset 裁剪为 0
    const clip = (style.clipPath || "") + (style.webkitClipPath || "");
    if (/(100%|circle\\(0|inset\\(\\s*100%)/i.test(clip)) return false;
    // 文字与背景同时全透明（横幅还在但完全看不见）
    if (
      alphaOf(style.backgroundColor) === 0 &&
      alphaOf(style.color) === 0
    ) {
      return false;
    }
    // 几何兜底：尺寸被压扁 / transform 缩放或位移出视口
    const rect = el.getBoundingClientRect();
    if (rect.width < 50 || rect.height < 8) return false;
    if (
      rect.bottom <= 0 ||
      rect.top >= innerHeight ||
      rect.right <= 0 ||
      rect.left >= innerWidth
    ) {
      return false;
    }
    return true;
  };

  let alarmed = false;
  const createAlarm = () => {
    const el = document.createElement("div");
    el.id = ALARM_ID;
    el.textContent = i18n.alarm;
    Object.assign(el.style, {
      position: "fixed",
      inset: "0",
      zIndex: "2147483647",
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
      padding: "40px",
      fontWeight: "700",
      fontSize: "18px",
      color: "#fff",
      background: "rgba(176, 0, 32, 0.97)",
    });
    return el;
  };

  const alarm = () => {
    if (alarmed) return;
    alarmed = true;
    try {
      self.console.warn("[dev-bridge] banner tampering detected, page replaced with warning");
    } catch {}
    // 整页替换为警告（后续由 observer/interval 持续恢复）
    document.documentElement.style.overflow = "hidden";
    while (document.body && document.body.firstChild) {
      document.body.firstChild.remove();
    }
    document.body.appendChild(createAlarm());
  };

  // 绝对置顶保障：重申最大 z-index，并保持为 documentElement 的最后一个
  // 子元素（相同 z-index 时，DOM 靠后者在视觉上层级更高）
  const keepOnTop = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.zIndex = MAX_Z;
    const root = document.documentElement;
    if (root.lastElementChild !== el) {
      root.appendChild(el);
    }
  };

  const check = () => {
    if (alarmed) {
      // 警告页同样被防篡改保护：被移除就恢复，且保持绝对置顶
      keepOnTop(ALARM_ID);
      if (!document.getElementById(ALARM_ID)) {
        document.body && document.body.appendChild(createAlarm());
      }
      return;
    }
    if (!isBannerVisible()) {
      // 文档解析期间横幅可能尚未就绪，先补挂；
      // 解析完成后横幅仍不可见，判定为页面脚本篡改，整页告警
      if (document.readyState === "loading") {
        ensureBanner();
      } else {
        alarm();
      }
      return;
    }
    keepOnTop(BANNER_ID);
  };

  ensureBanner();
  new Observer(check).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  ticker(check, 1000);
})();
`;

  // 判断当前请求是否需要启用 dev-bridge 拦截。
  // 双重开关：宿主必须在自己的 sw.js 中显式声明 globalThis.DEV_BRIDGE_ENABLED = true，
  // 且 systemConfig.devBridge.script 非空，二者缺一不可。
  const isDevBridgeRequest = (request, systemConfig) => {
    const { script } = systemConfig?.devBridge || {};
    return (
      globalThis.DEV_BRIDGE_ENABLED === true &&
      !!script &&
      request.method === "GET" &&
      request.destination === "document"
    );
  };

  // 包装 event.respondWith：所有经 SW 处理的导航响应统一过一遍注入
  const wrapDevBridgeRespond = (event, systemConfig) => {
    const originalRespondWith = event.respondWith.bind(event);
    let responded = false;
    event.respondWith = (promise) => {
      responded = true;
      originalRespondWith(
        Promise.resolve(promise).then((response) =>
          injectDevBridgeScript(response, systemConfig),
        ),
      );
    };
    // 返回探针函数：分支逻辑执行完后可据此判断是否已被响应
    return () => responded;
  };

  // 对 text/html 响应注入 dev bridge script；不满足条件时原样返回
  const injectDevBridgeScript = async (response, systemConfig) => {
    const { script, async: asyncAttr, banner = true } =
      systemConfig?.devBridge || {};

    if (!script || !response) {
      return response;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) {
      return response;
    }

    try {
      const html = await response.text();
      const headers = new Headers(response.headers);
      headers.delete("content-length");

      const headTag = html.match(/<head[^>]*>/i);
      if (!headTag) {
        // 无 <head>，按约定不注入；body 已被读取，需用原文重建响应
        return new Response(html, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }

      // 拼接注入 payload：横幅守卫脚本在前（含转义，避免 </script> 提前闭合），bridge script 在后
      const guardTag = banner
        ? `<script>${BANNER_GUARD_SCRIPT.replace(/<\/script/gi, "<\\/script")}</script>`
        : "";
      const attrs = asyncAttr ? " async" : "";
      const tag = guardTag + `<script src="${script}"${attrs}></script>`;
      const injected = html.replace(headTag[0], () => headTag[0] + tag);

      return new Response(injected, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
    } catch {
      // 读取或改写失败时回退原始响应
      return response;
    }
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

  // SWR 状态（host-cache 专用，与 cache-handlers.js 隔离）
  const SWR_TTL = 5 * 60 * 1000; // 5 分钟
  const lastRefreshAt = new Map(); // filePath -> 最近一次后台刷新时间
  const refreshing = new Set(); // 正在后台刷新的 filePath，用于去重

  // --- 配置 ---

  /**
   * 是否为开发环境（localhost）。
   * 开发环境下旁路 OPFS 缓存，确保宿主项目源码改动无需 bump version 即可立即生效。
   */
  const isDevEnv = () => {
    const hostname = self.location.hostname;
    return hostname === "localhost" || hostname === "127.0.0.1";
  };

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
      } catch (err) {
        console.warn(`[host-cache] precache failed: ${filePath}`, err.message || err);
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
      console.log("[host-cache] update skipped: already precaching");
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

      console.log(
        `[host-cache] update success: ${result.downloaded}/${result.total} downloaded, ${result.failed} failed`,
      );
      return { ok: true, ...result };
    } catch (err) {
      console.error("[host-cache] update failed:", err);
      return { ok: false, reason: "update-error", error: err.message };
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
      console.log(`[host-cache] loaded from OPFS: ${hostManifest.name}@${hostManifest.version}`);
    }

    // 尝试从网络拉取最新 manifest
    const manifestPath = getManifestPath();
    try {
      const response = await fetch(manifestPath, { cache: "no-store" });
      if (response.ok) {
        const latest = await response.json();
        if (!hostManifest || latest.version !== hostManifest.version) {
          // 版本变化或首次加载，触发预缓存
          console.log(`[host-cache] version changed, triggering update: ${latest.version}`);
          await updateHostCache(latest);
        } else {
          // 版本相同，仅更新内存状态
          hostManifest = latest;
          fileSet = new Set(latest.files || []);
          console.log(`[host-cache] version up-to-date: ${latest.version}`);
        }
      }
    } catch (err) {
      console.warn("[host-cache] init fetch failed, using OPFS cache:", err.message || err);
    }
  };

  // --- Fetch 拦截 ---

  /**
   * 同步检查路径是否在 host-cache 缓存列表中。
   * 用于 main.js 在调用 respondWith 之前做快速判断。
   */
  const isHostCachedFile = (path) => {
    if (!fileSet) return false;
    // 开发环境（localhost）旁路 OPFS 缓存，直接走网络
    if (isDevEnv()) return false;
    const filePath = path.replace(/^\//, "");
    if (!fileSet.has(filePath)) return false;
    // manifest 文件本身不走缓存，始终从网络获取
    if (path === getManifestPath()) return false;
    return true;
  };

  /**
   * 检查是否需要后台刷新；顺带回收过期条目。
   */
  const shouldRefresh = (filePath) => {
    const t = lastRefreshAt.get(filePath);
    if (!t) return true;
    if (Date.now() - t >= SWR_TTL) {
      lastRefreshAt.delete(filePath);
      return true;
    }
    return false;
  };

  /**
   * SWR 后台刷新：拉取最新文件覆盖 OPFS。
   * 离线跳过，并发去重。完成后下次刷新即可拿到新版本。
   */
  const refreshInBackground = (filePath, request) => {
    if (!navigator.onLine) return;
    if (refreshing.has(filePath)) return;
    refreshing.add(filePath);

    (async () => {
      try {
        const response = await fetch(request, { cache: "no-store" });
        if (!response.ok) return;
        const blob = await response.blob();
        const opfsPath = `${HOST_CACHE_DIR}/${FILES_DIR}/${filePath}`;
        const handle = await getFileHandle({ path: opfsPath, create: true });
        const stream = await handle.createWritable();
        await stream.write(blob);
        await stream.close();
        lastRefreshAt.set(filePath, Date.now());
        console.log(`[host-cache] background refreshed: ${filePath}`);
      } catch (err) {
        console.warn(
          `[host-cache] background refresh failed: ${filePath}`,
          err.message || err,
        );
      } finally {
        refreshing.delete(filePath);
      }
    })();
  };

  /**
   * 处理 host-cache 文件请求。
   * 生产环境采用 SWR：命中缓存立即返回，TTL 过期时后台刷新（下次刷新生效）；
   * 缓存未命中时同步回退网络并写入缓存。
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
        // SWR：立即返回缓存，TTL 过期时后台刷新
        if (shouldRefresh(filePath)) {
          refreshInBackground(filePath, request);
        }
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
        lastRefreshAt.set(filePath, Date.now());
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
   * SW 自行从网络拉取最新 manifest，与 OPFS 中持久化的版本对比，版本变化时才执行预缓存。
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
      console.warn("[host-cache] update failed: manifest not available");
      return new Response(
        JSON.stringify({ ok: false, reason: "manifest-not-available" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // 从 OPFS 读取持久化的版本进行对比（而非内存，确保手动删除 OPFS 后能重新拉取）
    const persisted = await loadManifestFromOPFS();
    if (persisted && manifest.version === persisted.version) {
      console.log(`[host-cache] version up-to-date: ${manifest.version}`);
      return new Response(
        JSON.stringify({ ok: true, reason: "version-up-to-date", version: manifest.version }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    console.log(`[host-cache] triggering update: ${manifest.name}@${manifest.version}`);
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

    // 从 OPFS 读取持久化的版本进行对比
    const persisted = await loadManifestFromOPFS();
    if (persisted && manifest.version === persisted.version) {
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

  const NONEOS_CORE_VERSION = "noneos-core@4.5.4";

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

    // dev-bridge 开发模式：包装 respondWith，让所有导航响应统一过注入逻辑
    let devBridgeResponded = null;
    if (isDevBridgeRequest(request, systemConfig)) {
      devBridgeResponded = wrapDevBridgeRespond(event, systemConfig);
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

    // dev-bridge：上面所有路由都未接管的导航请求，由 SW 主动 fetch 并注入
    if (devBridgeResponded && !devBridgeResponded()) {
      event.respondWith(
        (async () => {
          try {
            return await injectDevBridgeScript(
              await fetch(request),
              systemConfig,
            );
          } catch {
            return fetch(request);
          }
        })(),
      );
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
