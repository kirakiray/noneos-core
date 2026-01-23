import { handleGitHubRequest } from "./modules/github-handler.js";
import { handleFileRequest } from "./modules/file-handler.js";
import { handleNpmRequest } from "./modules/npm-handler.js";
import { handleMountRequest } from "./modules/mount-handle.js";
import { handleNosRequest } from "./modules/nos-handle.js";
import { handleNosToolRequest } from "./modules/nostool-handle.js";

// 当前系统的配置信息
// let systemConfig = {"version":"4.0.0","mode":"online","nosMapPath":"nos-4.0.0"};
let systemConfig = {};

const NONEOS_CORE_VERSION = "noneos-core@4.0.2";

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const { pathname } = new URL(request.url);

  // console.log("pathname: ", pathname);

  if (pathname === "/__version") {
    return event.respondWith(
      new Response(NONEOS_CORE_VERSION.replace("noneos-core@", "")),
    );
  }

  if (pathname === "/__config") {
    return event.respondWith(reloadSystemConfig());
  }

  try {
    if (SERVER_OPTIONS?.useNosTool && /^\/nos-tool\//.test(pathname)) {
      return event.respondWith(
        handleNosToolRequest({
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

  if (/^\/_/.test(pathname)) {
    // 隐藏目录开头的，属于本地文件，无需代理
    return;
  }
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

    return new Response(JSON.stringify(systemConfig));
  } catch (err) {
    console.error("Reload system config failed:", err);
    return new Response("Reload failed: " + (err.message || err), {
      status: 500,
    });
  }
};
