import { getFileHandle } from "./file-system.js";
import { getContentType } from "./mime-types.js";

/**
 * 从 NPM CDN 获取包文件
 * @param {Object} options - 选项
 * @param {string} options.path - 请求路径
 * @param {string} options.originUrl - 原始请求 URL
 * @returns {Promise<Response>} 响应对象
 */
export const handleNpmRequest = async ({ path }) => {
  // 将 /_npm/ 或 /npm/ 路径转换为 jsDelivr CDN URL
  // 例如: /_npm/jquery@3.6.0/dist/jquery.min.js
  // 转换为: https://cdn.jsdelivr.net/npm/jquery@3.6.0/dist/jquery.min.js
  const rePath = path.replace(/^\/_?npm\//, "https://cdn.jsdelivr.net/npm/");

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
