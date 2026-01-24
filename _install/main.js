import { get, init } from "../nos/fs/handle/main.js";
import { getFileHash } from "../nos/util/hash/get-file-hash.js";
import { getOnlineData } from "./online-data.js";

export const install = async () => {
  await installSystemFile();
};

// 安装系统文件
export const installSystemFile = async (callback) => {
  // 获取根证书，并生成验证器
  const { onlineNosConfig } = await getOnlineData();

  // 设置为在线模式
  await updateSystemConfig({
    mode: "online",
  });

  // 下载zip包
  const zipBlob = await fetch(import.meta.resolve("../nos.zip")).then((res) =>
    res.blob(),
  );

  const { unzip } = await import("../nos-tool/util/zip/main.js");

  // 解压缩文件
  const files = await unzip(zipBlob);

  const hashes = onlineNosConfig.hashes;

  const errors = [];

  // 等待被写入的文件
  const needWriteFiles = [];

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

    needWriteFiles.push({ path, file });
  }

  if (errors.length > 0) {
    throw new Error(errors.join("\n"));
  }

  const nosMapPath = "nos-" + onlineNosConfig.version;

  // 写入到本地
  for (let { path, file } of needWriteFiles) {
    await init(nosMapPath);
    const handle = await get(`${nosMapPath}/${path}`, { create: "file" });
    await handle.write(file);
  }

  await updateSystemConfig({
    version: onlineNosConfig.version,
    mode: "local",
    nosMapPath,
  });
};

// 设置使用在线文件
export const updateSystemConfig = async (options) => {
  await init("nos-config");

  let configHandle = await get("nos-config/system.json", {
    create: "file",
  });

  let configData = (await configHandle.json().catch(() => null)) || {};

  configData = {
    ...configData,
    ...options,
  };

  // 设置为在线模式
  await configHandle.write(JSON.stringify(configData));

  // const newConfigData = await fetch("/__config").then((e) => e.json()); // 触发更新配置文件
  await fetch("/__config").then((e) => e.json()); // 更新配置文件

  return configData;
};
