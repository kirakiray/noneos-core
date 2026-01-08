import { loadHandle } from "../../../nos/fs/handle/mount/db";
import { getContentType } from "./mime-types.js";

export const handleMountRequest = async ({ path, originUrl }) => {
  let pathname = decodeURIComponent(path);

  if (/\/$/.test(path)) {
    pathname += "index.html";
  }

  const mountedId = pathname.replace(/\/\$mount\-(.+)>.+/, "$1");
  const pathsArr = pathname.split("/").slice(2);

  // 改用直接的 opfs 读取文件方法
  try {
    const rootHandle = await loadHandle(mountedId);

    if (!rootHandle) {
      throw new Error(`Mounted ID ${mountedId} not found`);
    }

    let finalHandle = rootHandle;
    for (let i = 0; i < pathsArr.length; i++) {
      let part = pathsArr[i];
      const isLast = i === pathsArr.length - 1;
      if (isLast) {
        if (part === "") {
          part = "index.html";
        }
        finalHandle = await finalHandle.getFileHandle(part);
      } else {
        finalHandle = await finalHandle.getDirectoryHandle(part);
      }
    }

    const prefix = pathname.split(".").pop();

    return new Response(await finalHandle.getFile(), {
      status: 200,
      headers: {
        "Content-Type": getContentType(prefix),
      },
    });
  } catch (err) {
    return new Response(err.stack || err.toString(), {
      status: 400,
    });
  }
};
