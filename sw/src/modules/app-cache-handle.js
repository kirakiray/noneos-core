import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";

const CACHE_DIR = "app-cache";

// 内存中缓存的路径集合，用于快速判断是否需要拦截
// 从 OPFS app-cache/manifest.json 构建
let cachedPaths = null;

/**
 * 从 OPFS 读取 manifest 并构建已缓存路径集合
 * 在 SW activate 和 /__config 请求时调用
 */
export const initAppCachePaths = async () => {
  try {
    const manifestHandle = await getFileHandle({
      path: `${CACHE_DIR}/manifest.json`,
    }).catch(() => null);

    if (!manifestHandle) {
      cachedPaths = null;
      return;
    }

    const file = await manifestHandle.getFile();
    const manifest = JSON.parse(await file.text());

    if (Array.isArray(manifest.files)) {
      cachedPaths = new Set(
        manifest.files.map((f) => (f.startsWith("/") ? f : "/" + f)),
      );
    }
  } catch {
    cachedPaths = null;
  }
};

/**
 * 判断路径是否在应用缓存中
 */
export const hasAppCachePath = (pathname) => {
  if (!cachedPaths) return false;
  if (cachedPaths.has(pathname)) return true;
  // 目录访问自动补全 index.html
  if (pathname.endsWith("/")) {
    return cachedPaths.has(pathname + "index.html");
  }
  return false;
};

/**
 * 从 OPFS 读取应用缓存文件
 */
export const handleAppCacheRequest = async ({ path }) => {
  let relativePath = path.replace(/^\//, "");

  // 目录访问自动补全 index.html
  if (path.endsWith("/")) {
    relativePath += "index.html";
  }

  const fullPath = `${CACHE_DIR}/${relativePath}`;
  const fileHandle = await getFileHandle({ path: fullPath }).catch(() => null);

  if (fileHandle) {
    const file = await fileHandle.getFile();
    if (file.size) {
      return new Response(file, {
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
