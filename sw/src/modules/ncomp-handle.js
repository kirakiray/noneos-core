import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";

/**
 * 处理 /ncomp/ 资源请求
 * @param {Object} options - 选项
 * @param {string} options.path - 请求路径
 * @param {Request} options.request - 原始请求对象
 * @returns {Promise<Response>} 响应对象
 */
export const handleNcompRequest = async ({ path, request }) => {
  const host = location.host;

  // localhost:3002 调试模式直接请求资源，不读取 OPFS 缓存
  if (host === "localhost:3002") {
    return fetch(request);
  }

  // 请求官方源
  const fetchOfficial = async () => {
    const afterHost = request.url.replace(/^https?:\/\/[^\/]+\//, "");
    return fetch(`https://core.noneos.com/${afterHost}`);
  };

  // 从 OPFS 读取缓存
  const readFromCache = async () => {
    const targetHandle = await getFileHandle({ path }).catch(() => null);

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

    return null;
  };

  // 将响应写入 OPFS 缓存
  const writeToCache = async (blob) => {
    try {
      const targetHandle = await getFileHandle({ path, create: true });
      const writeStream = await targetHandle.createWritable();
      await writeStream.write(blob);
      await writeStream.close();
    } catch (err) {
      console.error("Failed to cache ncomp resource:", err);
    }
  };

  // 其他 localhost 端口下，优先将 /ncomp/ 请求代理到 localhost:3002 的在线资源
  if (/^localhost:/.test(host)) {
    const newUrl = request.url.replace(/:(\d+)/, ":3002");

    try {
      const response = await fetch(newUrl);

      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${newUrl}: ${response.status} ${response.statusText}`,
        );
      }

      const blob = await response.blob();
      await writeToCache(blob);

      return new Response(blob, {
        headers: {
          "Content-Type": getContentType(path),
        },
      });
    } catch {
      // localhost:3002 未启动或请求失败，继续走缓存 / 官方源路线
    }
  }

  // 优先读取 OPFS 缓存
  const cachedResponse = await readFromCache();

  if (cachedResponse) {
    return cachedResponse;
  }

  // 未命中缓存时请求官方源并写入缓存
  try {
    const response = await fetchOfficial();

    if (!response.ok) {
      throw new Error(
        `Failed to fetch official ncomp resource: ${response.status} ${response.statusText}`,
      );
    }

    const blob = await response.blob();
    await writeToCache(blob);

    return new Response(blob, {
      headers: {
        "Content-Type": getContentType(path),
      },
    });
  } catch (error) {
    console.error("Error fetching ncomp resource:", error);

    return new Response(`Error fetching ncomp resource: ${error.message}`, {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
};
