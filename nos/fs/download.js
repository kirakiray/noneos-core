// 下载将 handle 下载到本地
import { zip } from "../util/zip.js";

export const download = async (handle) => {
  if (!handle) {
    throw new Error("handle is required");
  }

  let files = [];

  const downloadFile = (file, downloadName) => {
    const url = URL.createObjectURL(file);
    const a = document.createElement("a");
    a.href = url;
    a.download = downloadName;
    a.target = "_blank";
    a.type = "application/octet-stream";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  };

  // 检查 handle 类型
  if (handle.kind === "file") {
    const file = await handle.file();
    downloadFile(file, file.name);
    return;
  }

  if (handle.kind === "dir") {
    const fileHandles = await handle.flat();
    for (const fileHandle of fileHandles) {
      const file = await fileHandle.file();
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

  if (files.length === 0) {
    throw new Error("No files to download");
  }

  if (files.length === 1) {
    downloadFile(files[0].file, files[0].path);
    return;
  }

  const zipBlob = await zip(files);
  if (!zipBlob) {
    throw new Error("Failed to create zip file");
  }

  downloadFile(zipBlob, `${handle.name || "download"}.zip`);
};

export default download;
