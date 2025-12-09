import { get } from "./fs.js";
import { getByGh } from "./get-by-platform.js";

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const { pathname, origin, searchParams } = new URL(request.url);

  console.log("pathname: ", pathname);

  if (/^\/_/.test(pathname)) {
    // 隐藏目录开头的，属于本地文件，无需代理
    return;
  }

  if (/^\/\$gh/.test(pathname)) {
    return event.respondWith(
      getByGh({
        path: pathname,
        url: request.url,
      })
    );
  }

  event.respondWith(
    get({
      request,
      url: request.url,
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
