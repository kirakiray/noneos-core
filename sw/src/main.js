import {
  handleGitHubRequest,
  handleNpmRequest,
  handleNosLibRequest,
} from "./modules/cache-handlers.js";
import { handleFileRequest } from "./modules/file-handler.js";
import { handleMountRequest } from "./modules/mount-handle.js";
import { handleNosRequest } from "./modules/nos-handle.js";
import { handleOfficialSourceRequest } from "./modules/official-handle.js";

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

const NONEOS_CORE_VERSION = "noneos-core@4.9.1";

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
