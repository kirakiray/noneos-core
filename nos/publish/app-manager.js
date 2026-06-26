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
  saveFileRef,
  getFileRef,
  incrementFileRef,
  getManifest,
} from "./db.js";

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
