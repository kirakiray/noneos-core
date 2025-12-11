(function () {
  'use strict';

  let rootHandle = null;

  /**
   * 获取根目录句柄
   * @returns {Promise<FileSystemDirectoryHandle>} 根目录句柄
   */
  const getRootDirectory = async () => {
    if (!rootHandle) {
      rootHandle = await navigator.storage.getDirectory();
    }

    return rootHandle;
  };

  /**
   * 获取文件句柄
   * @param {Object} options - 选项
   * @param {string} options.path - 文件路径
   * @param {boolean} [options.create] - 是否创建文件（如果不存在）
   * @returns {Promise<FileSystemFileHandle>} 文件句柄
   */
  const getFileHandle = async ({ path, create }) => {
    const rootHandle = await getRootDirectory();

    const paths = path.split("/");
    if (paths[0] === "") {
      paths.shift();
    }

    let currentHandle = rootHandle;
    let lastId = paths.length - 1;
    for (let i = 0; i < lastId; i++) {
      if (i == lastId) {
        break;
      }
      const p = paths[i];
      currentHandle = await currentHandle.getDirectoryHandle(p, { create });
    }

    const fileHandle = await currentHandle.getFileHandle(
      paths[paths.length - 1],
      { create }
    );

    return fileHandle;
  };

  /**
   * 根据文件扩展名获取 Content-Type
   * @param {string} path - 文件路径
   * @returns {string} Content-Type 值
   */
  const getContentType = (path) => {
    const prefix = path.split(".").slice(-1)[0];

    switch (prefix) {
      case "html":
      case "htm":
        return "text/html; charset=utf-8";
      case "txt":
      case "md":
        return "text/plain; charset=utf-8";
      case "js":
      case "mjs":
        return "application/javascript; charset=utf-8";
      case "json":
        return "application/json; charset=utf-8";
      case "css":
        return "text/css; charset=utf-8";
      case "xml":
        return "application/xml; charset=utf-8";
      case "svg":
        return "image/svg+xml; charset=utf-8";
      case "csv":
        return "text/csv; charset=utf-8";
      case "ics":
        return "text/calendar; charset=utf-8";
      case "pdf":
        return "application/pdf; charset=utf-8";
      case "doc":
      case "docx":
        return "application/msword; charset=utf-8";
      case "xls":
      case "xlsx":
        return "application/vnd.ms-excel; charset=utf-8";
      case "ppt":
      case "pptx":
        return "application/vnd.ms-powerpoint; charset=utf-8";
      case "zip":
        return "application/zip; charset=utf-8";
      case "gz":
        return "application/gzip; charset=utf-8";
      case "tar":
        return "application/x-tar; charset=utf-8";
      case "jpg":
      case "jpeg":
        return "image/jpeg";
      case "png":
        return "image/png";
      case "gif":
        return "image/gif";
      case "bmp":
        return "image/bmp";
      case "ico":
        return "image/x-icon";
      case "webp":
        return "image/webp";
      case "bmp":
        return "image/bmp";
      case "mp3":
        return "audio/mpeg";
      case "wav":
        return "audio/wav";
      case "mp4":
      case "m4v":
        return "video/mp4";
      case "mov":
        return "video/quicktime";
      case "avi":
        return "video/x-msvideo";
      default:
        return "application/javascript; charset=utf-8";
    }
  };

  /**
   * 从 GitHub 仓库获取文件
   * @param {Object} options - 选项
   * @param {string} options.path - 请求路径
   * @param {string} options.originUrl - 原始请求 URL
   * @returns {Promise<Response>} 响应对象
   */
  const handleGitHubRequest = async ({ path }) => {
    // 将 /gh/ 路径转换为 jsDelivr CDN URL
    const rePath = path.replace(/^\/gh\//, "https://cdn.jsdelivr.net/gh/");
    // const rePath = path.replace(/^\/gh\//, "https://cdn.statically.io/gh/");
    // console.log("gh: ", rePath);

    let targetHandle = await getFileHandle({ path }).catch(() => null);

    if (targetHandle) {
      const fileStream = await targetHandle.getFile();
      if (fileStream.size) {
        return new Response(fileStream, {
          headers: {
            "Content-Type": getContentType(path),
          },
        });
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
    return new Response(blob, {
      headers: {
        "Content-Type": getContentType(path),
      },
    });
  };

  /**
   * 从本地文件系统获取文件
   * @param {Object} options - 选项
   * @param {string} options.path - 请求路径
   * @param {string} options.originUrl - 原始请求 URL
   * @returns {Promise<Response>} 响应对象
   */
  const handleFileRequest = async ({ path }) => {
    const rePath = path.replace(/^\/\$/, "");

    const fileHandle = await getFileHandle({ path: rePath }).catch(() => null);

    if (fileHandle) {
      const fileStream = await fileHandle.getFile();
      if (fileStream.size) {
        return new Response(fileStream, {
          headers: {
            "Content-Type": getContentType(path),
          },
        });
      }
    }

    return new Response("Not Found", {
      status: 404,
      headers: {
        "Content-Type": getContentType(path),
      },
    });
  };

  /**
   * 从 NPM CDN 获取包文件
   * @param {Object} options - 选项
   * @param {string} options.path - 请求路径
   * @param {string} options.originUrl - 原始请求 URL
   * @returns {Promise<Response>} 响应对象
   */
  const handleNpmRequest = async ({ path }) => {
    // 将 /npm/ 路径转换为 jsDelivr CDN URL
    // 例如: /npm/jquery@3.6.0/dist/jquery.min.js
    // 转换为: https://cdn.jsdelivr.net/npm/jquery@3.6.0/dist/jquery.min.js
    const rePath = path.replace(/^\/npm\//, "https://cdn.jsdelivr.net/npm/");

    console.log("npm request: ", rePath);

    let targetHandle = await getFileHandle({ path }).catch(() => null);

    if (targetHandle) {
      const fileStream = await targetHandle.getFile();
      if (fileStream.size) {
        const type = fileStream.type || getContentType(path);
        return new Response(fileStream, {
          headers: {
            "Content-Type": type,
          },
        });
      }
    }

    try {
      // 请求实际文件
      const response = await fetch(rePath);

      // 检查响应状态
      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${rePath}: ${response.status} ${response.statusText}`
        );
      }

      const blob = await response.blob();

      // 写入缓存
      targetHandle = await getFileHandle({ path, create: true });
      const writeStream = await targetHandle.createWritable();
      await writeStream.write(blob);
      await writeStream.close();

      const type = blob.type || getContentType(path);

      // 转化为新的 Response 对象
      return new Response(blob, {
        headers: {
          "Content-Type": type,
        },
      });
    } catch (error) {
      console.error("Error fetching npm package:", error);

      return new Response(`Error fetching npm package: ${error.message}`, {
        status: 500,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
        },
      });
    }
  };

  self.addEventListener("fetch", (event) => {
    const { request } = event;
    const { pathname } = new URL(request.url);

    console.log("pathname: ", pathname);

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

})();
//# sourceMappingURL=sw.js.map
