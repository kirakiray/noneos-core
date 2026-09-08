import { PublicBaseHandle, notify } from "../public/base.js";
import { getHash } from "../../util/hash/get-hash.js";

export class BaseHandle extends PublicBaseHandle {
  // 对OPFS进行封装
  #originHandle = null;
  constructor(dirHandle, options = {}) {
    super(options);
    this.#originHandle = dirHandle;
  }

  get _handle() {
    return this.#originHandle;
  }

  // 暴露权限 API，上层可直接在包装句柄上查询/补授权
  // （requestPermission 需在用户手势中调用）
  queryPermission(options) {
    return this.#originHandle.queryPermission(options);
  }

  requestPermission(options) {
    return this.#originHandle.requestPermission(options);
  }

  get name() {
    return this.#originHandle.name;
  }

  async id() {
    const originHandle = this.#originHandle;

    if (originHandle.getUniqueId) {
      return await originHandle.getUniqueId();
    }

    return await getHash(this.path);
  }

  async isSame(target) {
    if (!target._handle) {
      return false;
    }
    return this.#originHandle.isSameEntry(target._handle);
  }

  async remove() {
    const parent = this.parent;

    // 最后删除当前目录或文件
    await parent.#originHandle.removeEntry(this.#originHandle.name, {
      recursive: true,
    });

    notify({
      type: "remove",
      path: this.path,
    });
  }

  async size() {
    if (this.kind === "file") {
      const file = await this.file();
      return file.size;
    }

    return null;
  }

  get _mark() {
    return "system";
  }
}
