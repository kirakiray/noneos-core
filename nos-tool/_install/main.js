import { get, init } from "../../nos/fs/handle/main.js";
import { getFileHash } from "../../nos/util/hash/get-file-hash.js";
import { unzip } from "../../nos/util/zip.js";
import { getOnlineData } from "./util.js";
import { registerSw, clearSw } from "./util.js";

const installStepTotal = 8;

// 执行安装程序
export const install = async (callback) => {
  callback = callback || (() => {});

  // 检测当前状态，决定是否需要重装 NoneOS Core
  const state = await check().catch(() => ({ state: "uninstalled" }));
  const needNoneOS =
    state.state === "uninstalled" ||
    (state.state === "upgradable" && !state.appCacheUpgradeOnly);

  if (needNoneOS) {
    await installServiceWorker(callback);
    await installSystemFile(callback);
  }

  // 自动安装/升级宿主缓存（如果宿主项目配置了 NONEOS_HOST_CACHE）
  await installHostCacheIfConfigured(callback);
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

  const { systemConfig, serviceWorkerVersion, hostCacheConfig } = configData;

  if (!serviceWorkerVersion || !systemConfig.version) {
    return {
      state: "uninstalled",
      systemConfig,
      serviceWorkerVersion,
      hostCacheConfig,
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
      hostCacheConfig,
    };
  }

  // NoneOS 已是最新，检查宿主缓存是否需要升级
  if (hostCacheConfig?.manifest) {
    try {
      const manifest = await fetch(hostCacheConfig.manifest, {
        cache: "no-store",
      }).then((r) => r.json());

      const localHostCacheVersion = systemConfig.hostCache?.version;
      if (localHostCacheVersion !== manifest.version) {
        return {
          state: "upgradable",
          version: systemConfig.version,
          localVersion: systemConfig.version,
          onlineVersion: onlineNosConfig.version,
          serviceWorkerVersion,
          hostCacheConfig,
          hostCacheUpgradeOnly: true,
          hostCacheLocalVersion: localHostCacheVersion || "",
          hostCacheOnlineVersion: manifest.version,
        };
      }
    } catch {
      // 离线或 manifest 获取失败，忽略
    }
  }

  return {
    state: "installed",
    version: systemConfig.version,
    hostCacheConfig,
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

  const zipBlob = await fetch(new URL("../../nos.zip", import.meta.url).href, {
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

  // 失败重试5次，每次间隔增加100毫秒
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await fetch("/__config").then((e) => e.json());
      break; // 成功则跳出循环
    } catch (err) {
      console.error(
        `Update system config failed (attempt ${attempt + 1}/5):`,
        err,
      );
      if (attempt < 4) {
        // 最后一次失败不需要等待
        await new Promise((resolve) =>
          setTimeout(resolve, (attempt + 1) * 100),
        );
      }
    }
  }

  return systemConfig;
};

// 宿主缓存默认存储目录
const HOST_CACHE_DIR = "host-cache";

/**
 * 安装/升级宿主缓存
 * 从 manifestUrl 获取清单，下载所有文件写入 OPFS，并更新 system.json
 * @param {string} manifestUrl - 清单文件的 URL（如 "/host-cache.json"）
 * @param {Function} callback - 进度回调 ({ step, total, desc })
 */
export const installHostCache = async (manifestUrl, callback) => {
  callback = callback || (() => {});

  callback({ desc: "loading host cache manifest", step: 1, total: 1 });

  const manifest = await fetch(manifestUrl, { cache: "no-store" }).then((r) => {
    if (!r.ok) throw new Error(`Failed to fetch manifest: ${r.status}`);
    return r.json();
  });

  const total = manifest.files.length + 2;

  // 版本相同则跳过
  await init("nos-config");
  const configFile = await get("nos-config/system.json", { create: "file" });
  const systemConfig = (await configFile.json().catch(() => null)) || {};

  if (
    systemConfig.hostCache?.version &&
    systemConfig.hostCache.version === manifest.version
  ) {
    callback({ desc: "host cache up to date", step: total, total });
    return;
  }

  // 准备缓存目录
  await init(HOST_CACHE_DIR);

  // 逐个下载并缓存文件
  for (let i = 0; i < manifest.files.length; i++) {
    const filePath = manifest.files[i];
    callback({ desc: `caching: ${filePath}`, step: i + 2, total });

    const blob = await fetch("/" + filePath, { cache: "no-store" }).then((r) => {
      if (!r.ok) throw new Error(`Failed to fetch ${filePath}: ${r.status}`);
      return r.blob();
    });

    const fileHandle = await get(`${HOST_CACHE_DIR}/${filePath}`, {
      create: "file",
    });
    await fileHandle.write(blob);
  }

  // 写入 manifest 副本（SW 读取此文件构建拦截路径集合）
  callback({ desc: "finalizing host cache", step: total, total });
  const manifestHandle = await get(`${HOST_CACHE_DIR}/manifest.json`, {
    create: "file",
  });
  await manifestHandle.write(JSON.stringify(manifest));

  // 更新 system.json
  await updateSystemConfig({
    hostCache: {
      version: manifest.version,
      cachePath: HOST_CACHE_DIR,
      mode: "local",
    },
  });
};

/**
 * 检查 SW 是否配置了宿主缓存，如果有则自动安装
 * 通过 /__config 获取 hostCacheConfig（由宿主 sw.js 中的 globalThis.NONEOS_HOST_CACHE 提供）
 */
const installHostCacheIfConfigured = async (callback) => {
  try {
    const configData = await fetch("/__config")
      .then((e) => e.json())
      .catch(() => null);

    if (configData?.hostCacheConfig?.manifest) {
      await installHostCache(configData.hostCacheConfig.manifest, callback);
    }
  } catch (err) {
    console.warn("Host cache installation skipped:", err);
  }
};
