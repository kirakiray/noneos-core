(function () {
  'use strict';

  const get = ({ request, path }) => {
    console.log(request, path, 3);
    return fetch(request);
  };

  // 从 GitHub 仓库获取文件
  const getByGh = async ({ path }) => {
    const rePath = path.replace(/^\/\$gh\//, "https://cdn.jsdelivr.net/gh/");
    console.log("gh: ", rePath);
    return fetch(rePath);
  };

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

})();
//# sourceMappingURL=sw.js.map
