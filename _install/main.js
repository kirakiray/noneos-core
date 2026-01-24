import { get, init } from "../nos/fs/handle/main.js";
import { getFileHash } from "../nos/util/hash/get-file-hash.js";
import { getOnlineData } from "./util.js";
import { registerSw, clearSw } from "./util.js";
import { unzip } from "../nos-tool/util/zip/main.js";

// 执行安装程序
export const install = async () => {
  await installServiceWorker();
  await installSystemFile();
};

// 检查系统的状况
export const check = async () => {
  await init("nos-config");

  const systemConfigFile = await get("nos-config/system.json", {
    create: "file",
  });

  let systemConfig = (await systemConfigFile.json().catch(() => null)) || {};

  let serviceWorkerVersion = await fetch("/__version")
    .then((e) => e.text())
    .catch(() => "");

  // 如果不是版本号格式，说明服务工作线程未安装，清空内容
  if (!/^\d+\.\d+\.\d+$/.test(serviceWorkerVersion)) {
    serviceWorkerVersion = "";
  }

  if (!serviceWorkerVersion || !systemConfig.version) {
    return {
      state: "uninstalled",
      systemConfig,
      serviceWorkerVersion,
    };
  }

  const { onlineNosConfig } = await getOnlineData();

  if (systemConfig.version !== onlineNosConfig.version) {
    return {
      state: "upgradable",
      localVersion: systemConfig.version,
      onlineVersion: onlineNosConfig.version,
      serviceWorkerVersion,
    };
  }

  return {
    state: "installed",
    version: systemConfig.version,
  };
};

export const installServiceWorker = async () => {
  // 先清除所有的注册
  await clearSw();

  // 先获取最新的版本号
  const { onlineNosConfig } = await getOnlineData();

  const registration = await registerSw("sw.js?v=" + onlineNosConfig.version);

  return registration;
};

// 安装系统文件
export const installSystemFile = async (callback) => {
  const { onlineNosConfig } = await getOnlineData();

  await updateSystemConfig({
    mode: "online",
  });

  const zipBlob = await fetch(import.meta.resolve("../nos.zip")).then((res) =>
    res.blob(),
  );

  const extractedFiles = await unzip(zipBlob);

  const fileHashes = onlineNosConfig.hashes;
  const errors = [];
  const pendingWriteFiles = [];

  for (const { hash, path } of fileHashes) {
    const matchedFile = extractedFiles.find((item) => item.path === path);

    if (!matchedFile) {
      errors.push(`File ${path} not found in zip`);
      continue;
    }

    const { file: targetFile } = matchedFile;
    const computedHash = await getFileHash(targetFile);

    if (computedHash !== hash) {
      errors.push(`File ${path} hash verification failed`);
    } else {
      pendingWriteFiles.push({ path, file: targetFile });
    }
  }

  if (errors.length > 0) {
    throw new AggregateError(errors, "File verification failed");
  }

  const nosMapPath = "nos-" + onlineNosConfig.version;

  await init(nosMapPath);

  for (const { path, file } of pendingWriteFiles) {
    const fileHandle = await get(`${nosMapPath}/${path}`, { create: "file" });
    await fileHandle.write(file);
    callback?.(path);
  }

  await updateSystemConfig({
    version: onlineNosConfig.version,
    mode: "local",
    nosMapPath,
  });
};

// 设置使用在线文件
const updateSystemConfig = async (options) => {
  await init("nos-config");

  const systemConfigFile = await get("nos-config/system.json", {
    create: "file",
  });

  let systemConfig = (await systemConfigFile.json().catch(() => null)) || {};

  systemConfig = {
    ...systemConfig,
    ...options,
  };

  await systemConfigFile.write(JSON.stringify(systemConfig));

  await fetch("/__config").then((e) => e.json());

  return systemConfig;
};
