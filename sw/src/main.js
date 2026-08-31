import {
  handleGitHubRequest,
  handleNpmRequest,
  handleNcompRequest,
} from "./modules/cache-handlers.js";
import { handleFileRequest } from "./modules/file-handler.js";
import {
  isDevBridgeRequest,
  injectDevBridgeScript,
} from "./modules/dev-bridge.js";
import {
  handleHostCacheMessage,
  handleHostCacheRequest,
  handleHostCacheStatus,
  initHostCache,
  isHostCachedFile,
  triggerHostCacheUpdate,
} from "./modules/host-cache-handler.js";
import { handleMountRequest } from "./modules/mount-handle.js";
import { handleNosRequest } from "./modules/nos-handle.js";
import { handleNosToolRequest } from "./modules/nostool-handle.js";

// 当前系统的配置信息
// let systemConfig = {"version":"4.0.0","mode":"online","nosMapPath":"nos-4.0.0"};
let systemConfig = {};

// 配置就绪 Promise：fetch 判断（如 dev-bridge 开关）依赖 systemConfig，
// SW 冷启动时首个请求可能早于 OPFS 读取完成，必须先 await 该 Promise。
let configReadyPromise = null;

// 读取 OPFS 中的系统配置；失败（如 nos-config/system.json 不存在）时
// 保留当前配置（初始为空对象）并正常 resolve，绝不 reject 或挂起
const loadSystemConfig = async () => {
  try {
    const rootHandle = await navigator.storage.getDirectory();
    const configHandle = await rootHandle.getDirectoryHandle("nos-config");
    const configFileHandle = await configHandle.getFileHandle("system.json");
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

const NONEOS_CORE_VERSION = "noneos-core@4.5.5";

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

  // dev-bridge 开发模式：包装 respondWith，等待配置就绪后，
  // 让所有经 SW 处理的导航响应统一过注入逻辑（冷启动首个请求也不例外）。
  // 总开关是同步全局量，未开启时直接短路，保持与未包装时完全一致的请求路径
  let devBridgeRespondWith = null;
  let isDevBridgeResponded = null;
  if (globalThis.DEV_BRIDGE_ENABLED === true) {
    const configReady = ensureConfigReady();
    const originalRespondWith = event.respondWith.bind(event);
    let responded = false;
    devBridgeRespondWith = (fallbackPromise) => {
      originalRespondWith(
        (async () => {
          await configReady;
          if (isDevBridgeRequest(request, systemConfig)) {
            return injectDevBridgeScript(
              await Promise.resolve(fallbackPromise),
              systemConfig,
            );
          }
          return fallbackPromise;
        })(),
      );
    };
    event.respondWith = (promise) => {
      responded = true;
      devBridgeRespondWith(promise);
    };
    isDevBridgeResponded = () => responded;
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

  // dev-bridge：上面所有路由都未接管的顶层导航，由 SW 主动 fetch 并注入。
  // 仅在总开关开启时接管；关闭时不调用 respondWith，交还浏览器默认行为
  if (
    devBridgeRespondWith &&
    !isDevBridgeResponded() &&
    request.method === "GET" &&
    request.destination === "document"
  ) {
    const configReady = ensureConfigReady();
    devBridgeRespondWith(
      (async () => {
        await configReady;
        if (!isDevBridgeRequest(request, systemConfig)) {
          return fetch(request);
        }
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
  // 预热配置加载，把冷启动首个导航的等待压到最低
  ensureConfigReady();
  console.log("NoneOS installation successful");
});

self.addEventListener("activate", () => {
  self.clients.claim();
  ensureConfigReady();
  console.log("NoneOS server activation successful");
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

// 初始化宿主项目缓存（仅在宿主项目配置了 HOST_CACHE_CONFIG 时生效）
if (globalThis.HOST_CACHE_CONFIG) {
  initHostCache();
}
