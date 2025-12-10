import { getFileHandle } from "./fs.js";
import { getContentType } from "./util.js";

// 从 GitHub 仓库获取文件
export const getByGh = async ({ path }) => {
  const rePath = path.replace(/^\/_gh\//, "https://cdn.jsdelivr.net/gh/");
  // const rePath = path.replace(/^\/_gh\//, "https://cdn.statically.io/gh/");

  console.log("gh: ", rePath);

  let targetHandle = await getFileHandle({ path }).catch(() => null);

  if (targetHandle) {
    const fileStream = await targetHandle.getFile();
    if (fileStream.size) {
      return new Response(fileStream, {
        headers: {
          "Content-Type": getContentType(path),
        },
      });
    }
  }

  // 请求实际文件
  const response = await fetch(rePath);
  const blob = await response.blob();

  // 写入缓存
  targetHandle = await getFileHandle({ path, create: true });
  const writeStream = await targetHandle.createWritable();
  await writeStream.write(blob);
  await writeStream.close();

  // 转化为新的 Response 对象
  return new Response(blob, {
    headers: {
      "Content-Type": getContentType(path),
    },
  });
};
