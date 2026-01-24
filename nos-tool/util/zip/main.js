import { Unzip, UnzipInflate, zip as fflateZip } from "./fflate.mjs";

export async function unzip(file) {
  const unzipper = new Unzip();

  // ⚠️ 关键：注册 DEFLATE 压缩处理器（type 8）
  unzipper.register(UnzipInflate);

  const files = [];
  let pendingFiles = 0;

  unzipper.onfile = (fileInfo) => {
    pendingFiles++;
    const chunks = [];
    let totalSize = 0;

    fileInfo.ondata = (err, chunk, final) => {
      if (err) {
        console.error("解压错误:", err);
        return;
      }
      chunks.push(chunk);
      totalSize += chunk.length;

      if (final) {
        // 合并所有 chunks
        const result = new Uint8Array(totalSize);
        let offset = 0;
        for (const c of chunks) {
          result.set(c, offset);
          offset += c.length;
        }

        pendingFiles--;

        if (!fileInfo.name.endsWith("/")) {
          files.push({
            path: fileInfo.name,
            file: new File([result], fileInfo.name.split("/").pop()),
          });
        }

        // console.log(`✅ 完成: ${fileInfo.name} (${totalSize} bytes)`);
      }
    };

    // 开始解压该文件
    fileInfo.start();
  };

  // 流式读取文件
  const stream = file.stream();
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      // 喂数据给解压器
      unzipper.push(value || new Uint8Array(0), done);
      if (done) break;
    }
  } catch (err) {
    console.error("读取文件流错误:", err);
    throw err;
  }

  return files;
}

export const zip = async (files) => {
  if (!files.length) return null;

  const fileObj = {};

  for (const { file, path } of files) {
    const arrayBuffer = await file.arrayBuffer();
    fileObj[path] = new Uint8Array(arrayBuffer);
  }

  return new Promise((resolve, reject) => {
    fflateZip(fileObj, (err, data) => {
      if (err) {
        reject(err);
      } else {
        resolve(new Blob([data], { type: "application/zip" }));
      }
    });
  });
};
