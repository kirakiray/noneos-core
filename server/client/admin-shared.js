import toast from "https://punch-ui-v2.pages.dev/packages/util/toast.js";

let _adminUser = null;
let _adminInfo = null;
let _promise = null;

const ADMIN_JSON_URL = "/tests/user/local/admin.json";
const ADMIN_NS = "admin-shared-ns";

const DEFAULT_SERVER_URL = "ws://localhost:8081";
const SERVER_URL_KEY = "noneos-admin-server-url";
const SERVER_HISTORY_KEY = "noneos-admin-server-history";
const MAX_HISTORY = 10;

/**
 * 获取当前管理员应用连接的服务器地址
 * 优先从 localStorage 读取，否则返回默认值
 * @returns {string}
 */
export function getCurrentServerUrl() {
  try {
    const url = localStorage.getItem(SERVER_URL_KEY);
    if (url) return url;
  } catch {
    // localStorage 不可用则回退默认值
  }
  return DEFAULT_SERVER_URL;
}

/**
 * 设置当前管理员应用连接的服务器地址
 * @param {string} url
 */
export function setCurrentServerUrl(url) {
  try {
    localStorage.setItem(SERVER_URL_KEY, url);
  } catch {
    // 忽略写入失败
  }
}

/**
 * 获取保存的服务器地址历史列表
 * @returns {string[]}
 */
export function getServerHistory() {
  try {
    const raw = localStorage.getItem(SERVER_HISTORY_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length > 0) return list;
    }
  } catch {
    // 回退默认值
  }
  return [DEFAULT_SERVER_URL];
}

/**
 * 将地址加入历史列表，去重并限制数量
 * @param {string} url
 */
export function addServerHistory(url) {
  if (!url) return;
  let list = getServerHistory().filter((u) => u !== url);
  list.unshift(url);
  if (list.length > MAX_HISTORY) list = list.slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(SERVER_HISTORY_KEY, JSON.stringify(list));
  } catch {
    // 忽略写入失败
  }
}

/**
 * 从历史列表中移除指定地址
 * @param {string} url
 */
export function removeServerHistory(url) {
  const list = getServerHistory().filter((u) => u !== url);
  try {
    localStorage.setItem(SERVER_HISTORY_KEY, JSON.stringify(list));
  } catch {
    // 忽略写入失败
  }
}

/**
 * 显示服务器连接失败的 Toast 提示
 * @param {string} url
 * @param {Error} [error]
 */
export function showServerError(url, error) {
  const message = error?.message || "无法连接服务器";
  toast({
    message: `连接失败：${message}（${url}）`,
    color: "error",
    duration: 5000,
  });
}

export async function getAdmin(load) {
  if (_adminUser) return { adminUser: _adminUser, adminInfo: _adminInfo };
  if (_promise) return _promise;

  _promise = (async () => {
    const { saveUserKeys, saveUserInfo } = await load("/nos/user/db.js");
    const { deleteUser } = await load("/nos/user/main.js");
    const { AdminUser } = await load("/nos/user/admin-user.js");

    const adminData = await fetch(ADMIN_JSON_URL).then((r) => r.json());

    try {
      await deleteUser(ADMIN_NS, { skipConfirm: true });
    } catch (e) {
      /* ignore */
    }
    await saveUserKeys(ADMIN_NS, adminData.keys);
    await saveUserInfo(ADMIN_NS, adminData.info);

    const adminUser = new AdminUser(ADMIN_NS);
    await adminUser.ready();

    _adminUser = adminUser;
    const info = await adminUser.getInfo();
    _adminInfo = {
      userId: adminUser.userId,
      username: info.username || "Admin",
    };

    return { adminUser: _adminUser, adminInfo: _adminInfo };
  })();

  return _promise;
}
