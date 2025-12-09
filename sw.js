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
    const response = await fetch(rePath);

    // 获取文本内容
    const text = await response.text();

    // 转化为新的 Response 对象
    const newResponse = new Response(text, response);

    return newResponse;
  };

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

})();
//# sourceMappingURL=sw.js.map
