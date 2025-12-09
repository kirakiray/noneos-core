import { get } from "./fs.js";
import { getByGh } from "./get-by-platform.js";

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const { pathname } = new URL(request.url);

  console.log("pathname: ", pathname);

  if (/^\/_/.test(pathname)) {
    // 隐藏目录开头的，属于本地文件，无需代理
    return;
  }

  if (/^\/\$gh/.test(pathname)) {
    // 从 GitHub 仓库获取文件
    return event.respondWith(
      getByGh({
        path: pathname,
        originUrl: request.url,
      })
    );
  }

  event.respondWith(
    get({
      request,
      originUrl: request.url,
      path: pathname,
    })
  );
});

self.addEventListener("install", () => {
  self.skipWaiting();
  console.log("NoneOS installation successful");
});

self.addEventListener("activate", () => {
  self.clients.claim();
  console.log("NoneOS server activation successful");
});
