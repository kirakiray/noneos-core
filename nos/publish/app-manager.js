// AppManager — 应用发布管理器
//
// 基于 DataPublisher 实现应用的发布、发现、安装与管理。
//
// 核心数据流：
// - createRelease(handle, { appName, version }) → 遍历目录 → 计算 fileHash → 签名 → ReleaseInfo
// - publish(release) → 逐个 publish 文件 → publish manifest → 记录 published_apps → 更新 file_refs
// - discoverApps({ publisherUserId }) → 查询已发布应用列表
// - fetchManifest(appId) → 从 DataPublisher 拉取签名的 asset-manifest.json

import { DataPublisher } from "./data-publisher.js";
import { getFileHash } from "../util/hash/get-file-hash.js";
import { getHash } from "../util/hash/get-hash.js";
import { verifyData } from "../crypto/crypto-verify.js";
import {
  savePublishedApp,
  getPublishedApp,
  listPublishedApps,
  incrementFileRef,
  getManifest,
} from "./db.js";
import { init } from "../fs/handle/main.js";

/** 简单语义化版本号比较，返回正数/零/负数 */
function semverCompare(a, b) {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * 应用发布管理器
 *
 * @example
 * ```js
 * const user = new LocalUser("my-namespace");
 * await user.ready();
 *
 * const manager = new AppManager(user);
 * manager.start();
 *
 * const handle = await init("my-app");
 * const release = await manager.createRelease(handle, {
 *   appName: "my-app",
 *   version: "0.1.0",
 * });
 *
 * // UI 展示 release 信息让用户确认
 * const result = await manager.publish(release);
 * ```
 */
export class AppManager {
  #user;
  #publisher;
  #started = false;
  #releaseCache = new WeakMap();

  /**
   * @param {import("../user/user.js").LocalUser} localUser - 本地用户实例
   */
  constructor(localUser) {
    if (!localUser) throw new Error("localUser is required");
    this.#user = localUser;
    this.#publisher = new DataPublisher(localUser);
  }

  /**
   * 获取内部 DataPublisher 实例（用于高级控制）
   */
  get publisher() {
    return this.#publisher;
  }

  /**
   * 启动监听
   */
  start() {
    if (this.#started) return;
    this.#publisher.start();
    this.#started = true;
  }

  /**
   * 停止监听
   */
  stop() {
    this.#publisher.stop();
    this.#started = false;
  }

  // ───── 发布流程 ─────

  /**
   * 创建发布候选（预览阶段）
   *
   * 遍历虚拟目录 handle 的所有文件，计算 fileHash，构建签名的 asset-manifest，
   * 并缓存文件 Blob 供 publish 阶段使用。
   *
   * @param {import("../fs/handle/dir.js").DirHandle} handle - 虚拟目录 Handle
   * @param {{ appName: string, version: string }} options - 应用信息
   * @returns {Promise<ReleaseInfo>} { manifest, diffSummary, fileCount, totalSize }
   */
  async createRelease(handle, { appName, version }) {
    if (!handle) throw new Error("handle is required");
    if (!appName || !version) throw new Error("appName and version are required");

    // 1. 获取所有文件
    const fileHandles = await handle.flat();
    if (fileHandles.length === 0) {
      throw new Error("No files found in the given handle");
    }

    // 2. 遍历文件，计算 fileHash，缓存 Blob
    const files = {};
    const fileBlobs = new Map();
    const handlePath = handle.path;

    for (const fh of fileHandles) {
      const file = await fh.read({ type: "file" });
      const fileHash = await getFileHash(file);

      // 计算相对路径：去掉 handle 路径前缀
      let relativePath = fh.path;
      if (relativePath.startsWith(handlePath + "/")) {
        relativePath = relativePath.slice(handlePath.length + 1);
      }

      files[relativePath] = { fileHash, size: file.size };
      fileBlobs.set(relativePath, file);
    }

    // 3. 计算 appId
    const appId = await getHash(appName + this.#user.userId);

    // 4. 检查是否已有已发布版本（升级场景）
    const existingApp = await getPublishedApp(this.#user.namespace, appName);
    let diffSummary = null;

    if (existingApp && existingApp.status === "published" && existingApp.manifestHash) {
      diffSummary = await this.#computeDiffSummary(
        existingApp.manifestHash,
        files,
      );
    }

    // 5. 构建 manifest 并签名
    const manifest = await this.#user._sign({
      appId,
      appName,
      version,
      publisherUserId: this.#user.userId,
      previousManifestHash: existingApp && existingApp.status === "published"
        ? existingApp.manifestHash
        : null,
      files,
    });

    // 6. 组装 ReleaseInfo
    const releaseInfo = Object.freeze({
      manifest,
      diffSummary,
      fileCount: Object.keys(files).length,
      totalSize: Object.values(files).reduce((sum, f) => sum + f.size, 0),
    });

    // 7. 缓存文件 Blob
    this.#releaseCache.set(releaseInfo, { fileBlobs });

    return releaseInfo;
  }

  /**
   * 发布应用
   *
   * 1. 验签 manifest
   * 2. 逐个 publish 文件（验证 hash 后通过 DataPublisher 发布）
   * 3. publish manifest 自身
   * 4. 更新 published_apps 记录和 file_refs 引用计数
   *
   * @param {ReleaseInfo} release - createRelease 返回的 ReleaseInfo 对象
   * @returns {Promise<{ appId: string, appName: string, version: string, publishedAt: number }>}
   */
  async publish(release) {
    const cached = this.#releaseCache.get(release);
    if (!cached) {
      throw new Error(
        "Invalid release: not created by this AppManager instance or already published",
      );
    }

    const { manifest } = release;
    const { fileBlobs } = cached;

    // 1. 验签
    const isValid = await verifyData(manifest);
    if (!isValid) {
      throw new Error("Manifest signature verification failed");
    }

    const { appId, appName, version, files } = manifest;

    // 2. 逐个发布文件
    for (const [relativePath, fileInfo] of Object.entries(files)) {
      const blob = fileBlobs.get(relativePath);
      if (!blob) {
        throw new Error(`File not found in cache: ${relativePath}`);
      }

      // 重新验证 fileHash
      const actualHash = await getFileHash(blob);
      if (actualHash !== fileInfo.fileHash) {
        throw new Error(
          `File hash mismatch for "${relativePath}": expected ${fileInfo.fileHash}, got ${actualHash}`,
        );
      }

      // 通过 DataPublisher 发布
      await this.#publisher.publish(blob);

      // 更新引用计数
      await incrementFileRef(this.#user.namespace, fileInfo.fileHash, appId);
    }

    // 3. 发布 manifest 自身
    const manifestJson = JSON.stringify(manifest, null, 2);
    const manifestFile = new File([manifestJson], "asset-manifest.json", {
      type: "application/json",
    });
    const manifestResult = await this.#publisher.publish(manifestFile);
    const manifestHash = manifestResult.fileHash;

    // 记录 manifest 自身的引用
    await incrementFileRef(this.#user.namespace, manifestHash, appId);

    // 4. 保存/更新 published_apps 记录
    const now = Date.now();
    const existingApp = await getPublishedApp(this.#user.namespace, appName);

    await savePublishedApp(this.#user.namespace, {
      appId,
      appName,
      version,
      manifestHash,
      publisherUserId: this.#user.userId,
      status: "published",
      publishedAt: existingApp ? existingApp.publishedAt : now,
      updatedAt: now,
    });

    // 5. 清理缓存
    this.#releaseCache.delete(release);

    return { appId, appName, version, publishedAt: now };
  }

  // ───── 发现 ─────

  /**
   * 发现应用列表
   *
   * @param {{ publisherUserId?: string }} [query] - 查询条件
   * @returns {Promise<AppInfo[]>} 应用信息列表
   */
  async discoverApps({ publisherUserId } = {}) {
    // 目前仅支持查询自身发布的应用
    // 远程查询将在后续版本实现（通过 DataPublisher 协议扩展）
    const apps = await listPublishedApps(this.#user.namespace);
    return apps
      .filter((a) => a.status === "published")
      .map((a) => ({
        appId: a.appId,
        appName: a.appName,
        version: a.version,
        publisherUserId: a.publisherUserId,
        publishedAt: a.publishedAt,
      }));
  }

  /**
   * 获取已签名的 asset-manifest.json
   *
   * @param {string} appId - 应用 ID
   * @returns {Promise<Object|null>} 签名的 manifest 对象，未找到返回 null
   */
  async fetchManifest(appId) {
    // 在已发布的应用中查找匹配的 appId
    const apps = await listPublishedApps(this.#user.namespace);
    const app = apps.find((a) => a.appId === appId);
    if (!app) return null;

    try {
      const result = await this.#publisher.assembleFile(app.manifestHash);
      const text = await result.blob.text();
      return JSON.parse(text);
    } catch {
      return null;
    }
  }

  // ───── 自身发布管理 ─────

  /**
   * 获取自己发布的应用列表
   *
   * @returns {Promise<AppInfo[]>}
   */
  async listMyPublishedApps() {
    const apps = await listPublishedApps(this.#user.namespace);
    return apps
      .filter((a) => a.status === "published")
      .map((a) => ({
        appId: a.appId,
        appName: a.appName,
        version: a.version,
        publisherUserId: a.publisherUserId,
        publishedAt: a.publishedAt,
      }));
  }

  /**
   * 取消发布应用（下架）
   *
   * 只将状态改为 "unpublished"，不删除 DataPublisher 中的文件数据。
   * 后续可通过 publish() 重新上架。
   * 如果应用未发布过，静默成功（幂等）。
   *
   * @param {string} appName
   * @returns {Promise<void>}
   */
  async unpublishApp(appName) {
    const app = await getPublishedApp(this.#user.namespace, appName);
    if (!app) return;

    await savePublishedApp(this.#user.namespace, {
      ...app,
      status: "unpublished",
      updatedAt: Date.now(),
    });
  }

  // ───── 安装 / 更新 ─────

  /**
   * 安装应用
   *
   * 1. 验签 manifest
   * 2. 将每个文件通过 DataPublisher 获取并写入 apps/{appName}-{appId}/
   * 3. 写入 asset-manifest.json
   *
   * 如果目录已存在（升级场景），只拉取和覆写有变化的文件。
   *
   * @param {Object} manifest - 已签名的 asset-manifest.json 对象
   * @param {{ publisherUser?: import("../user/remote-user.js").RemoteUser }} [options]
   *   - publisherUser: 发布者的 RemoteUser，不传则只查本地 DataPublisher 缓存
   * @returns {Promise<void>}
   */
  async installApp(manifest, { publisherUser } = {}) {
    // 1. 验签
    const isValid = await verifyData(manifest);
    if (!isValid) {
      throw new Error("Manifest signature verification failed");
    }

    const { appId, appName, version, files } = manifest;
    const dirName = `${appName}-${appId}`;

    // 2. 确保 apps/ 根目录存在
    let appsRoot;
    try {
      appsRoot = await init("apps");
    } catch {
      appsRoot = await init("apps");
    }

    // 3. 创建或获取应用目录
    const appDir = await appsRoot.get(dirName, { create: "dir" });

    // 4. 读取旧 manifest（升级场景）
    const oldManifestFile = await appDir.get("asset-manifest.json");
    let oldFiles = null;
    if (oldManifestFile) {
      try {
        const oldText = await oldManifestFile.read({ type: "text" });
        oldFiles = JSON.parse(oldText).files || {};
      } catch {
        // 旧 manifest 损坏，忽略
      }
    }

    // 5. 遍历文件，只拉取有变化的
    for (const [relativePath, fileInfo] of Object.entries(files)) {
      // 升级场景：hash 相同则跳过
      if (oldFiles && oldFiles[relativePath] && oldFiles[relativePath].fileHash === fileInfo.fileHash) {
        continue;
      }

      // 通过 DataPublisher 获取文件（本地优先，远程兜底）
      const result = await this.#publisher.fetchFile(
        publisherUser || null,
        fileInfo.fileHash,
      );

      // 按相对路径创建子目录（如有）并写入文件
      const pathParts = relativePath.split("/");
      const fileName = pathParts.pop();
      let targetDir = appDir;
      if (pathParts.length > 0) {
        targetDir = await appDir.get(pathParts.join("/"), { create: "dir" });
      }
      const targetFile = await targetDir.get(fileName, { create: "file" });
      await targetFile.write(result.blob);
    }

    // 6. 删除旧版有但新版没有的文件（升级场景）
    if (oldFiles) {
      for (const [oldPath] of Object.entries(oldFiles)) {
        if (!files[oldPath]) {
          const pathParts = oldPath.split("/");
          const fileName = pathParts.pop();
          try {
            let delDir = appDir;
            if (pathParts.length > 0) {
              delDir = await appDir.get(pathParts.join("/"));
            }
            if (delDir) {
              const delFile = await delDir.get(fileName);
              if (delFile) await delFile.remove();
            }
          } catch {
            // 文件不存在则忽略
          }
        }
      }
    }

    // 7. 写入 asset-manifest.json
    const manifestContent = JSON.stringify(manifest, null, 2);
    const manifestFile = await appDir.get("asset-manifest.json", { create: "file" });
    await manifestFile.write(manifestContent);
  }

  /**
   * 检查单个应用是否有更新
   *
   * 对比本地已安装版本与发布者的最新版本。
   *
   * @param {string} appId - 应用 ID
   * @returns {Promise<UpdateInfo|null>}
   *   null 表示未找到已安装的应用；
   *   { hasUpdate: false } 表示已是最新；
   *   否则返回 { hasUpdate: true, appName, currentVersion, latestVersion, diffSummary, manifest }
   */
  async checkForUpdates(appId) {
    // 1. 读取本地已安装的 manifest
    const localManifest = await this.#readInstalledManifest(appId);
    if (!localManifest) return null;

    // 2. 获取发布者最新版本
    const latestManifest = await this.fetchManifest(appId);
    if (!latestManifest) {
      // 发布者已下架或不可用
      return { hasUpdate: false };
    }

    // 3. 比较版本
    if (latestManifest.version === localManifest.version) {
      return { hasUpdate: false };
    }

    // 4. 生成 diffSummary
    const diffSummary = this.#compareFileSets(localManifest.files, latestManifest.files);

    return {
      hasUpdate: true,
      appName: localManifest.appName,
      currentVersion: localManifest.version,
      latestVersion: latestManifest.version,
      diffSummary,
      manifest: latestManifest,
    };
  }

  /**
   * 批量检查所有已安装应用的更新
   *
   * @returns {Promise<UpdateInfo[]>}
   */
  async checkAllUpdates() {
    const installed = await this.#listInstalledAppIds();
    const results = [];
    for (const appId of installed) {
      try {
        const info = await this.checkForUpdates(appId);
        if (info) results.push(info);
      } catch (err) {
        console.warn(`[AppManager] checkForUpdates failed for ${appId}:`, err.message);
      }
    }
    return results;
  }

  // ───── 本地已安装管理 ─────

  /**
   * 获取所有已安装应用的列表
   *
   * 遍历 apps/ 目录，从每个子目录的 asset-manifest.json 中读取应用信息。
   *
   * @returns {Promise<AppInfo[]>}
   */
  async listInstalledApps() {
    const appsRoot = await this.#ensureAppsRoot();
    const list = [];
    for await (const [name, handle] of appsRoot.entries()) {
      if (handle.kind !== "dir") continue;
      const manifestFile = await handle.get("asset-manifest.json");
      if (!manifestFile) continue;
      try {
        const text = await manifestFile.read({ type: "text" });
        const manifest = JSON.parse(text);
        if (manifest.appId && manifest.appName) {
          list.push({
            appId: manifest.appId,
            appName: manifest.appName,
            version: manifest.version,
            publisherUserId: manifest.publisherUserId,
          });
        }
      } catch {
        // 跳过损坏的 manifest
      }
    }
    return list;
  }

  /**
   * 根据 appName 获取已安装应用的 asset-manifest.json
   *
   * @param {string} appName - 应用名称
   * @returns {Promise<Object|null>} 签名的 manifest 对象，未找到返回 null
   */
  async getInstalledAppInfo(appName) {
    const appsRoot = await this.#ensureAppsRoot();
    for await (const [name, handle] of appsRoot.entries()) {
      if (handle.kind !== "dir") continue;
      const manifestFile = await handle.get("asset-manifest.json");
      if (!manifestFile) continue;
      try {
        const text = await manifestFile.read({ type: "text" });
        const manifest = JSON.parse(text);
        if (manifest.appName === appName) return manifest;
      } catch {
        // 跳过损坏的 manifest
      }
    }
    return null;
  }

  /**
   * 卸载已安装的应用
   *
   * 扫描 apps/ 目录，找到 appName 匹配的应用目录后整体删除。
   * 如果应用不存在，静默成功（幂等）。
   *
   * @param {string} appName - 应用名称
   * @returns {Promise<void>}
   */
  async uninstallApp(appName) {
    const appsRoot = await this.#ensureAppsRoot();
    for await (const [name, handle] of appsRoot.entries()) {
      if (handle.kind !== "dir") continue;
      const manifestFile = await handle.get("asset-manifest.json");
      if (!manifestFile) continue;
      try {
        const text = await manifestFile.read({ type: "text" });
        const manifest = JSON.parse(text);
        if (manifest.appName === appName) {
          await handle.remove();
          return;
        }
      } catch {
        // 跳过损坏的 manifest
      }
    }
    // 未找到 → 幂等成功
  }

  // ───── 内部辅助 ─────

  /**
   * 确保 apps/ 目录存在并返回其句柄
   */
  async #ensureAppsRoot() {
    let appsRoot;
    try {
      appsRoot = await init("apps");
    } catch {
      appsRoot = await init("apps");
    }
    return appsRoot;
  }

  /**
   * 遍历 apps/ 目录，获取所有已安装应用的 appId
   */
  async #listInstalledAppIds() {
    const appsRoot = await this.#ensureAppsRoot();
    const ids = [];
    for await (const [name, handle] of appsRoot.entries()) {
      if (handle.kind !== "dir") continue;
      const manifestFile = await handle.get("asset-manifest.json");
      if (!manifestFile) continue;
      try {
        const text = await manifestFile.read({ type: "text" });
        const manifest = JSON.parse(text);
        if (manifest.appId) ids.push(manifest.appId);
      } catch {
        // 跳过损坏的 manifest
      }
    }
    return ids;
  }

  /**
   * 根据 appId 查找已安装应用的 manifest
   */
  async #readInstalledManifest(appId) {
    const appsRoot = await this.#ensureAppsRoot();
    for await (const [name, handle] of appsRoot.entries()) {
      if (handle.kind !== "dir") continue;
      const manifestFile = await handle.get("asset-manifest.json");
      if (!manifestFile) continue;
      try {
        const text = await manifestFile.read({ type: "text" });
        const manifest = JSON.parse(text);
        if (manifest.appId === appId) return manifest;
      } catch {
        // 跳过损坏的 manifest
      }
    }
    return null;
  }

  /**
   * 对比两组文件集合，生成变更摘要
   */
  #compareFileSets(oldFiles, newFiles) {
    const added = {};
    const modified = {};
    const removed = {};
    let sizeDelta = 0;

    for (const [path, info] of Object.entries(newFiles)) {
      if (!oldFiles[path]) {
        added[path] = info;
        sizeDelta += info.size;
      } else if (oldFiles[path].fileHash !== info.fileHash) {
        modified[path] = {
          oldHash: oldFiles[path].fileHash,
          newHash: info.fileHash,
          oldSize: oldFiles[path].size,
          newSize: info.size,
        };
        sizeDelta += info.size - oldFiles[path].size;
      }
    }

    for (const [path, info] of Object.entries(oldFiles)) {
      if (!newFiles[path]) {
        removed[path] = info;
        sizeDelta -= info.size;
      }
    }

    return { added, modified, removed, sizeDelta };
  }

  // ───── 内部工具 ─────

  /**
   * 计算与旧版本的文件变更摘要
   */
  async #computeDiffSummary(oldManifestHash, newFiles) {
    try {
      const oldResult = await this.#publisher.assembleFile(oldManifestHash);
      const oldText = await oldResult.blob.text();
      const oldManifest = JSON.parse(oldText);
      const oldFiles = oldManifest.files || {};

      const added = {};
      const modified = {};
      const removed = {};
      let sizeDelta = 0;

      // 检查新增和修改
      for (const [path, info] of Object.entries(newFiles)) {
        if (!oldFiles[path]) {
          // 新增
          added[path] = info;
          sizeDelta += info.size;
        } else if (oldFiles[path].fileHash !== info.fileHash) {
          // 修改
          modified[path] = {
            oldHash: oldFiles[path].fileHash,
            newHash: info.fileHash,
            oldSize: oldFiles[path].size,
            newSize: info.size,
          };
          sizeDelta += info.size - oldFiles[path].size;
        }
      }

      // 检查删除
      for (const [path, info] of Object.entries(oldFiles)) {
        if (!newFiles[path]) {
          removed[path] = info;
          sizeDelta -= info.size;
        }
      }

      return {
        added,
        modified,
        removed,
        sizeDelta,
      };
    } catch {
      // 旧 manifest 不可获取时，跳过 diff
      return null;
    }
  }
}
