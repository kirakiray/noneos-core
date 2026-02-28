import { get, init } from "../nos/fs/handle/main.js";
import { getFileHash } from "../nos/util/hash/get-file-hash.js";
import { getOnlineData } from "./util.js";
import { registerSw, clearSw } from "./util.js";
import { unzip } from "../nos/util/zip.js";

const installStepTotal = 8;

// 执行安装程序
export const install = async (callback) => {
  callback = callback || (() => {});

  await installServiceWorker(callback);
  await installSystemFile(callback);
};

// 检查系统的状况
export const check = async () => {
  await init("nos-config");

  const configData = await fetch("/__config")
    .then((e) => e.json())
    .catch(() => ({
      serviceWorkerVersion: "",
      systemConfig: {},
    }));

  const { systemConfig, serviceWorkerVersion } = configData;

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
      version: systemConfig.version,
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

export const installServiceWorker = async (callback) => {
  // 先清除所有的注册
  await clearSw();

  callback({
    desc: "loading online nos config",
    total: installStepTotal,
    step: 1,
  });

  // await new Promise((resolve) => setTimeout(resolve, 200));

  // 先获取最新的版本号
  const { onlineNosConfig } = await getOnlineData();

  callback({
    desc: "registering service worker",
    total: installStepTotal,
    step: 2,
  });

  // await new Promise((resolve) => setTimeout(resolve, 200));

  const registration = await registerSw("sw.js?v=" + onlineNosConfig.version);

  return registration;
};

// 安装系统文件
export const installSystemFile = async (callback) => {
  callback({
    desc: "ready to install system files",
    total: installStepTotal,
    step: 3,
  });

  // await new Promise((resolve) => setTimeout(resolve, 200));

  const { onlineNosConfig } = await getOnlineData();

  await updateSystemConfig({
    mode: "online",
  });

  callback({
    desc: "download system files",
    total: installStepTotal,
    step: 4,
  });

  // await new Promise((resolve) => setTimeout(resolve, 200));

  const zipBlob = await fetch(import.meta.resolve("../nos.zip"), {
    cache: "no-store",
  }).then((res) => res.blob());

  callback({
    desc: "extracting system files",
    total: installStepTotal,
    step: 5,
  });

  // await new Promise((resolve) => setTimeout(resolve, 200));

  const extractedFiles = await unzip(zipBlob);

  const fileHashes = onlineNosConfig.hashes;
  const errors = [];
  const pendingWriteFiles = [];

  callback({
    desc: "verifying system files",
    total: installStepTotal,
    step: 6,
  });

  // await new Promise((resolve) => setTimeout(resolve, 200));

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

  callback({
    desc: "writing system files",
    total: installStepTotal,
    step: 7,
  });

  // await new Promise((resolve) => setTimeout(resolve, 200));

  for (const { path, file } of pendingWriteFiles) {
    const fileHandle = await get(`${nosMapPath}/${path}`, { create: "file" });
    await fileHandle.write(file);
    callback?.(path);
  }

  // 写入nos.json文件
  const nosJsonFile = await get(`${nosMapPath}/nos.json`, { create: "file" });
  await nosJsonFile.write(JSON.stringify(onlineNosConfig));

  await updateSystemConfig({
    version: onlineNosConfig.version,
    mode: "local",
    nosMapPath,
  });
};

// 设置使用在线文件
export const updateSystemConfig = async (options) => {
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
