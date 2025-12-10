(function () {
  'use strict';

  let rootHandle = null;

  // 获取根目录句柄
  const getRoot = async () => {
    if (!rootHandle) {
      rootHandle = await navigator.storage.getDirectory();
    }

    return rootHandle;
  };

  // 获取文件句柄
  const getFileHandle = async ({ path, create }) => {
    const rootHandle = await getRoot();

    const paths = path.split("/");
    if (paths[0] === "") {
      paths.shift();
    }

    let currentHandle = rootHandle;
    let lastName = paths[paths.length - 1];
    for (const p of paths) {
      if (p === lastName) {
        break;
      }
      currentHandle = await currentHandle.getDirectoryHandle(p, { create });
    }

    const fileHandle = await currentHandle.getFileHandle(lastName, { create });

    return fileHandle;
  };

  // 从 GitHub 仓库获取文件
  const getByGh = async ({ path }) => {
    const rePath = path.replace(/^\/_gh\//, "https://cdn.jsdelivr.net/gh/");
    // const rePath = path.replace(/^\/_gh\//, "https://cdn.statically.io/gh/");

    console.log("gh: ", rePath);

    let targetHandle = await getFileHandle({ path }).catch(() => null);

    if (targetHandle) {
      const fileStream = await targetHandle.getFile();
      if (fileStream.size) {
        return new Response(fileStream);
      }
    }

    // 请求实际文件
    const response = await fetch(rePath);
    const blob = await response.blob();

    // 写入缓存
    targetHandle = await getFileHandle({ path, create: true });
    const writeStream = await targetHandle.createWritable();
    await writeStream.write(blob);
    await writeStream.close();

    // 转化为新的 Response 对象
    return new Response(blob);
  };

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

})();
//# sourceMappingURL=sw.js.map
