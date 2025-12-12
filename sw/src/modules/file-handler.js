import { getFileHandle } from './file-system.js';
import { getContentType } from './mime-types.js';

/**
 * 从本地文件系统获取文件
 * @param {Object} options - 选项
 * @param {string} options.path - 请求路径
 * @param {string} options.originUrl - 原始请求 URL
 * @returns {Promise<Response>} 响应对象
 */
export const handleFileRequest = async ({ path }) => {
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