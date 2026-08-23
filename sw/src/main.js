import {
  handleGitHubRequest,
  handleNpmRequest,
  handleNcompRequest,
} from "./modules/cache-handlers.js";
import { handleFileRequest } from "./modules/file-handler.js";
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

const NONEOS_CORE_VERSION = "noneos-core@4.4.4";

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
