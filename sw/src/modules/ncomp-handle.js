import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";
import { getHash } from "../../../nos/util/hash/get-hash.js";
import { shouldRefresh, markRefreshed, refreshInBackground } from "./swr-cache.js";

const META_DIR = "/nos-config/ncomp-meta";

/**
 * 获取 ncomp 资源的元数据路径
 */
const getMetaPath = (path) => {
  const relativePath = path.replace(/^\/ncomp\//, "");
  return `${META_DIR}/${relativePath}.json`;
};

/**
 * 读取 ncomp 资源的元数据
 * @returns {Promise<{cachedAt:number,hash:string}|null>}
 */
const readMeta = async (path) => {
  const targetHandle = await getFileHandle({ path: getMetaPath(path) }).catch(
    () => null,
  );
  if (!targetHandle) return null;
  const fileStream = await targetHandle.getFile();
  if (!fileStream.size) return null;
  try {
    return JSON.parse(await fileStream.text());
  } catch {
    return null;
  }
};

/**
 * 写入 ncomp 资源的元数据
 */
const writeMeta = async (path, meta) => {
  try {
    const targetHandle = await getFileHandle({
      path: getMetaPath(path),
      create: true,
    });
    const writeStream = await targetHandle.createWritable();
    await writeStream.write(JSON.stringify(meta));
    await writeStream.close();
  } catch (err) {
    console.error("Failed to write ncomp meta:", err);
  }
};

/**
 * 创建 Response 对象
 */
const createResponse = (body, path) => {
  return new Response(body, {
    headers: { "Content-Type": getContentType(path) },
  });
};

/**
 * 写入缓存和元数据（首次缓存或内容变更后调用）
 */
const writeCacheAndMeta = async (path, blob) => {
  try {
    const targetHandle = await getFileHandle({ path, create: true });
    const writeStream = await targetHandle.createWritable();
    await writeStream.write(blob);
    await writeStream.close();
  } catch (err) {
    console.error("Failed to cache ncomp resource:", err);
  }
};

/**
 * 处理 /ncomp/ 资源请求
 *
 * 非 localhost 环境采用 Stale-While-Revalidate 策略：
 * 缓存命中立即返回，后台异步刷新并校验 hash
 */
export const handleNcompRequest = async ({ path, request }) => {
  const host = location.host;

  // 请求官方源
  const fetchOfficial = async () => {
    const afterHost = request.url.replace(/^https?:\/\/[^\/]+\//, "");
    return fetch(`https://core.noneos.com/${afterHost}`);
  };

  // 请求当前运行的网站（同域兜底）
  const fetchCurrent = async () => {
    return fetch(new URL(path, location.origin).href);
  };

  // localhost 环境下，优先将 /ncomp/ 请求代理到 localhost:3002 的在线资源
  if (/^localhost:/.test(host)) {
    const newUrl = request.url.replace(/:(\d+)/, ":3002");

    try {
      const response = await fetch(newUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch ${newUrl}: ${response.status} ${response.statusText}`,
        );
      }

      const arrayBuffer = await response.arrayBuffer();
      const blob = new Blob([arrayBuffer]);
      const hash = await getHash(arrayBuffer);

      // 写入缓存和元数据
      await writeCacheAndMeta(path, blob);
      await writeMeta(path, { cachedAt: Date.now(), hash });
      markRefreshed(path);

      return createResponse(blob, path);
    } catch {
      // localhost:3002 未启动或请求失败，继续走缓存 / 官方源路线
    }
  }

  // 读取 OPFS 缓存
  let targetHandle = await getFileHandle({ path }).catch(() => null);
  let cachedFile = null;
  if (targetHandle) {
    const fileStream = await targetHandle.getFile();
    if (fileStream.size) cachedFile = fileStream;
  }

  // 缓存命中：SWR 模式，立即返回，后台异步刷新
  if (cachedFile) {
    if (shouldRefresh(path)) {
      refreshInBackground({
        path,
        rePath: `https://core.noneos.com/${request.url.replace(/^https?:\/\/[^\/]+\//, "")}`,
        tag: "ncomp",
        onWrite: async (blob) => {
          const arrayBuffer = await blob.arrayBuffer();
          const hash = await getHash(arrayBuffer);
          const meta = await readMeta(path);
          if (meta && hash === meta.hash) {
            // 内容未变：仅刷新 cachedAt，跳过写盘
            await writeMeta(path, { ...meta, cachedAt: Date.now() });
            return null;
          }
          // 内容已变：更新 OPFS 和元数据
          await writeMeta(path, { cachedAt: Date.now(), hash });
          return blob;
        },
      });
    }
    return createResponse(cachedFile, path);
  }

  // 缓存未命中：同步请求网络
  try {
    const response = await fetchOfficial();
    if (!response.ok) {
      throw new Error(
        `Failed to fetch official ncomp resource: ${response.status} ${response.statusText}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();
    const blob = new Blob([arrayBuffer]);
    const hash = await getHash(arrayBuffer);

    // 写入缓存和元数据
    await writeCacheAndMeta(path, blob);
    await writeMeta(path, { cachedAt: Date.now(), hash });
    markRefreshed(path);

    return createResponse(blob, path);
  } catch (error) {
    // localhost 环境下，官方源失败时尝试同域兜底
    if (/^localhost:/.test(host)) {
      try {
        const currentResponse = await fetchCurrent();
        if (currentResponse.ok) {
          const arrayBuffer = await currentResponse.arrayBuffer();
          const blob = new Blob([arrayBuffer]);
          const hash = await getHash(arrayBuffer);

          await writeCacheAndMeta(path, blob);
          await writeMeta(path, { cachedAt: Date.now(), hash });
          markRefreshed(path);

          return createResponse(blob, path);
        }
      } catch {
        // 当前网站也失败，继续走兜底
      }
    }

    // 网络失败时回退到旧缓存
    if (cachedFile) {
      return createResponse(cachedFile, path);
    }

    console.error("Error fetching ncomp resource:", error);
    return new Response(`Error fetching ncomp resource: ${error.message}`, {
      status: 500,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
};