let rootHandle = null;

/**
 * 获取根目录句柄
 * @returns {Promise<FileSystemDirectoryHandle>} 根目录句柄
 */
export const getRootDirectory = async () => {
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
export const getFileHandle = async ({ path, create }) => {
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