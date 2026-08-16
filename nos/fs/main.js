export { init } from "./handle/main.js";
import {
  open,
  mount,
  getMounted,
  unmount,
  get as mountedGet,
} from "./handle/mount/mount.js";
export { open, mount, getMounted, unmount };
import { get as systemHandleGet } from "./handle/main.js";

export const get = async (path, options) => {
  if (!path) {
    throw new Error("path is required");
  }

  if (path.startsWith("$mount-")) {
    return mountedGet(path, options);
  }

  return systemHandleGet(path, options);
};
