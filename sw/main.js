import { getByGh } from "./get-by-platform.js";

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const { pathname } = new URL(request.url);

  console.log("pathname: ", pathname);

  if (/^\/_gh\//.test(pathname)) {
    // 从 GitHub 仓库获取文件
    return event.respondWith(
      getByGh({
        path: pathname,
        originUrl: request.url,
      })
    );
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
