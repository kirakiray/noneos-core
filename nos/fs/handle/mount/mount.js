import { DirHandle } from "../dir.js";
import { RESET_PATH, PICKED } from "../../public/base.js";
import { saveHandle, loadHandle, deleteHandle, getAllHandles } from "./db.js";

// 查询权限（只查不申请）
// requestPermission 必须在用户手势中调用，而 get("$mount-...") 是
// nos-storage 还原句柄的必经路径，常在无手势时被触发，
// 此处若主动申请会被 Chrome 以 SecurityError 拒绝；
// 授权应由上层拿到包装句柄后在用户手势里调用 requestPermission 补齐。
const checkPermission = async (handle) => {
  if (!handle?.queryPermission) {
    return "denied";
  }

  try {
    return await handle.queryPermission({ mode: "readwrite" });
  } catch (err) {
    throw new Error(`Permission denied: ${err.message}`);
  }
};

export const open = async (options) => {
  if (!window.showDirectoryPicker) {
    throw new Error("showDirectoryPicker is not supported");
  }

  const mode = options?.mode || "readwrite";

  // 打开文件选择器
  const directoryHandle = await window.showDirectoryPicker({
    id: options?.id,
    mode,
  });

  const permission = await checkPermission(directoryHandle);

  // 刚从 picker 返回仍在用户手势窗口内，可安全补授权
  if (permission !== "granted") {
    await directoryHandle.requestPermission({ mode });
  }

  const handle = new DirHandle(directoryHandle);

  // 标记来源：未 mount 前 path 不可还原，不允许被持久化
  handle[PICKED] = true;

  if (options?.mount) {
    await mount(handle);
  }

  return handle;
};

export const mount = async (handle) => {
  if (!handle[RESET_PATH]) {
    const id = await saveHandle(handle._handle);

    handle[RESET_PATH] = `$mount-${id}>${encodeURI(handle.name)}`;
  }

  // 已挂载，path 变为可还原的 $mount- 形式，解除限制
  delete handle[PICKED];

  return handle;
};

export const unmount = async (idOrHandle) => {
  let id;

  if (typeof idOrHandle === "string") {
    id = idOrHandle;
  } else if (idOrHandle && idOrHandle.path) {
    const path = idOrHandle.path;
    
    if (!path.startsWith("$mount-")) {
      throw new Error("Only mounted handles can be unmounted");
    }

    const rootName = path.split("/")[0];
    const [mark] = rootName.split(">");
    id = mark.replace(/\$mount-/, "");
  } else {
    throw new Error("Invalid argument: expected id string or handle object");
  }

  const handle = await loadHandle(id);
  if (!handle) {
    throw new Error(`Handle ${id} does not exist`);
  }

  return deleteHandle(id);
};

export const get = async (path, options) => {
  const pathArr = path.split("/");
  const rootName = pathArr[0];
  const [mark, reRootName] = rootName.split(">");
  const dirId = mark.replace(/\$mount-/, "");

  const _handle = await loadHandle(dirId);

  if (!_handle) {
    throw new Error(`Mounted handle "$mount-${dirId}" does not exist (unmounted?)`);
  }

  await checkPermission(_handle);

  const handle = new DirHandle(_handle);

  handle[RESET_PATH] = `$mount-${dirId}>${encodeURI(reRootName)}`;

  if (pathArr.length === 1) {
    return handle;
  }

  const remainingPath = pathArr.slice(1).join("/");

  return handle.get(remainingPath, options);
};

// 获取已经挂载的句柄列表
export const getMounted = async () => {
  const allHandles = await getAllHandles();

  // 重新包装
  return allHandles.map((item) => {
    const handle = new DirHandle(item.handle);

    handle[RESET_PATH] = `$mount-${item.id}>${encodeURI(item.handle.name)}`;

    return {
      id: item.id,
      name: item.handle.name,
      path: handle.path,
      handle,
    };
  });
};
