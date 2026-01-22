import { get, init } from "/nos/fs/handle/main.js";
import { verifyData } from "/nos/crypto/crypto-verify.js";
import { unzip } from "/nos/util/zip/main.js";
import { getFileHash } from "/nos/util/hash/get-file-hash.js";

export const install = async () => {
  // 获取根证书，并生成验证器
  const rootCert = await fetch("/nos/root-cert.json").then((e) => e.json());
  const isRootCertValid = await verifyData(rootCert);

  if (!isRootCertValid) {
    throw new Error("Root certificate verification failed");
  }

  // 查看在线 nos.json 文件
  const onlineNosConfig = await fetch("./nos.json").then((res) => res.json());

  // 验证nos.json 中的 hashes 是否被擅改
  const isNosJsonValid = await verifyData(onlineNosConfig);

  if (!isNosJsonValid) {
    throw new Error("nos.json verification failed");
  }

  // 获取本地 nos.json 文件配置
  await init("nos-config");
  const configHandle = await get("nos-config/system.json", {
    create: "file",
  });

  // 下载zip包
  const zipBlob = await fetch("./nos.zip").then((res) => res.blob());

  // 解压缩文件
  const files = await unzip(zipBlob);

  const hashes = onlineNosConfig.hashes;

  const errors = [];

  for (let { hash, path } of hashes) {
    const targetItem = files.find((item) => item.path === path);

    if (!targetItem) {
      errors.push(`File ${path} not found in zip`);
      continue;
    }

    // 确保文件没被篡改
    const { file } = targetItem;
    const fileHash = await getFileHash(file);

    if (fileHash !== hash) {
      errors.push(`File ${path} hash verification failed`);
    }
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  debugger;

  // 写入 nos.json 文件配置
  await configHandle.write(
    JSON.stringify({
      version: onlineNosConfig.version,
      mode: "online",
      nosMapPath: "nos",
    }),
  );
};
