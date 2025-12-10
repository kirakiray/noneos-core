let rootHandle = null;

// 获取根目录句柄
export const getRoot = async () => {
  if (!rootHandle) {
    rootHandle = await navigator.storage.getDirectory();
  }

  return rootHandle;
};

// 获取文件句柄
export const getFileHandle = async ({ path, create }) => {
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

// 获取目录句柄
export const getDirHandle = async ({ path, create }) => {
  const rootHandle = await getRoot();
  const dirHandle = await rootHandle.getDirectoryHandle(path, { create });
  
  return dirHandle;
};
