// 下载将 handle 下载到本地
import { zip } from "../util/zip.js";

export const download = async (handle) => {
  if (!handle) {
    throw new Error("handle is required");
  }

  let files = [];

  // 检查 handle 类型
  if (handle.kind === "file") {
    // 单个文件
    const file = await handle.file();
    files.push({
      file,
      path: file.name
    });
  } else if (handle.kind === "dir") {
    // 文件夹，获取所有子文件
    const fileHandles = await handle.flat();
    for (const fileHandle of fileHandles) {
      const file = await fileHandle.file();
      // 构建相对路径
      let path = file.name;
      let current = fileHandle.parent;
      while (current && current !== handle) {
        path = `${current.name}/${path}`;
        current = current.parent;
      }
      files.push({
        file,
        path
      });
    }
  } else {
    throw new Error("Invalid handle type");
  }

  // 打包成 zip 文件
  const zipBlob = await zip(files);
  if (!zipBlob) {
    throw new Error("Failed to create zip file");
  }

  // 创建下载链接
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement("a");
  a.href = url;
  a.download = handle.kind === "file" ? `${handle.name}.zip` : `${handle.name || "download"}.zip`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

export default download;
