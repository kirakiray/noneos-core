import { handleGitHubRequest } from "./modules/github-handler.js";
import { handleFileRequest } from "./modules/file-handler.js";
import { handleNpmRequest } from "./modules/npm-handler.js";

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const { pathname } = new URL(request.url);

  // console.log("pathname: ", pathname);

  try {
    if (/^\/gh\//.test(pathname)) {
      // 从 GitHub 仓库获取文件
      return event.respondWith(
        handleGitHubRequest({
          path: pathname,
          originUrl: request.url,
        })
      );
    }

    if (/^\/npm\//.test(pathname)) {
      // 从 NPM CDN 获取包文件
      return event.respondWith(
        handleNpmRequest({
          path: pathname,
          originUrl: request.url,
        })
      );
    }

    if (/^\/\$/.test(pathname)) {
      return event.respondWith(
        handleFileRequest({
          path: pathname,
          originUrl: request.url,
        })
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
});
