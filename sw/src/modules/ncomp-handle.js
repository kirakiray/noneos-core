import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";
import { getHash } from "../../../nos/util/hash/get-hash.js";

const TTL = 5 * 60 * 1000; // 5 分钟
const META_DIR = "/nos-config/ncomp-meta";

/**
 * 获取 ncomp 资源的元数据路径
 * @param {string} path - ncomp 资源路径
 * @returns {string} 元数据文件路径
 */
const getMetaPath = (path) => {
  const relativePath = path.replace(/^\/ncomp\//, "");
  return `${META_DIR}/${relativePath}.json`;
};

/**
 * 读取 ncomp 资源的元数据
 * @param {string} path - ncomp 资源路径
 * @returns {Promise<{cachedAt:number,hash:string}|null>} 元数据对象
 */
const readMeta = async (path) => {
  const targetHandle = await getFileHandle({ path: getMetaPath(path) }).catch(
    () => null,
  );

  if (!targetHandle) {
    return null;
  }

  const fileStream = await targetHandle.getFile();

  if (!fileStream.size) {
    return null;
  }

  try {
    return JSON.parse(await fileStream.text());
  } catch {
    return null;
  }
};

/**
 * 写入 ncomp 资源的元数据
 * @param {string} path - ncomp 资源路径
 * @param {Object} meta - 元数据对象
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
 * 从 OPFS 读取缓存
 * @param {string} path - ncomp 资源路径
 * @returns {Promise<File|null>} 缓存文件或 null
 */
const readFromCache = async (path) => {
  const targetHandle = await getFileHandle({ path }).catch(() => null);

  if (!targetHandle) {
    return null;
  }

  const fileStream = await targetHandle.getFile();

  if (!fileStream.size) {
    return null;
  }

  return fileStream;
};

/**
 * 将响应写入 OPFS 缓存
 * @param {string} path - ncomp 资源路径
 * @param {Blob} blob - 响应内容
 */
const writeToCache = async (path, blob) => {
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
 * 创建 Response 对象
 * @param {Blob|File} body - 响应体
 * @param {string} path - ncomp 资源路径
 * @returns {Response} 响应对象
 */
const createResponse = (body, path) => {
  return new Response(body, {
    headers: {
      "Content-Type": getContentType(path),
    },
  });
};

/**
 * 异步更新 OPFS 缓存：对比 hash，有变化则写入，无变化则刷新缓存时间
 * @param {string} path - ncomp 资源路径
 * @param {ArrayBuffer} arrayBuffer - 最新响应内容
 * @param {{cachedAt:number,hash:string}|null} meta - 当前元数据
 */
const updateCacheAsync = async (path, arrayBuffer, meta) => {
  try {
    const hash = await getHash(arrayBuffer);

    if (!meta || hash !== meta.hash) {
      await writeToCache(path, new Blob([arrayBuffer]));
      await writeMeta(path, { cachedAt: Date.now(), hash });
    } else {
      await writeMeta(path, { ...meta, cachedAt: Date.now() });
    }
  } catch (err) {
    console.error("Failed to update ncomp cache:", err);
  }
};

/**
 * 处理 /ncomp/ 资源请求
 * @param {Object} options - 选项
 * @param {string} options.path - 请求路径
 * @param {Request} options.request - 原始请求对象
 * @returns {Promise<Response>} 响应对象
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

  // 从 OPFS 读取缓存（带元数据）
  const readCacheWithMeta = async () => {
    const [cachedFile, meta] = await Promise.all([
      readFromCache(path),
      readMeta(path),
    ]);
    return { cachedFile, meta };
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
      const { meta } = await readCacheWithMeta();

      // localhost 下需要确保缓存可靠写入，以便 3002 不可用时能回退
      await updateCacheAsync(path, arrayBuffer, meta);

      return createResponse(new Blob([arrayBuffer]), path);
    } catch {
      // localhost:3002 未启动或请求失败，继续走缓存 / 官方源路线
    }
  }

  const { cachedFile, meta } = await readCacheWithMeta();

  // 缓存有效（未过期且有内容）：直接返回
  if (cachedFile && meta && Date.now() - meta.cachedAt < TTL) {
    return createResponse(cachedFile, path);
  }

  // 缓存过期或不存在：请求网络，立刻返回最新数据，后台异步更新 OPFS
  try {
    const response = await fetchOfficial();

    if (!response.ok) {
      throw new Error(
        `Failed to fetch official ncomp resource: ${response.status} ${response.statusText}`,
      );
    }

    const arrayBuffer = await response.arrayBuffer();

    updateCacheAsync(path, arrayBuffer, meta);

    return createResponse(new Blob([arrayBuffer]), path);
  } catch (error) {
    // localhost 环境下，官方源失败时尝试直接请求当前运行的网站（同域兜底）
    if (/^localhost:/.test(host)) {
      try {
        const currentResponse = await fetchCurrent();

        if (currentResponse.ok) {
          const arrayBuffer = await currentResponse.arrayBuffer();

          updateCacheAsync(path, arrayBuffer, meta);

          return createResponse(new Blob([arrayBuffer]), path);
        }
      } catch {
        // 当前网站也失败，继续走旧缓存兜底
      }
    }

    // 网络失败时回退到旧缓存
    if (cachedFile) {
      return createResponse(cachedFile, path);
    }

    console.error("Error fetching ncomp resource:", error);

    return new Response(`Error fetching ncomp resource: ${error.message}`, {
      status: 500,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
    });
  }
};
