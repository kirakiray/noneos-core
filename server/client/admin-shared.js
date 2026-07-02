import toast from "https://punch-ui-v2.pages.dev/packages/util/toast.js";

let _adminUser = null;
let _adminInfo = null;
let _promise = null;

const ADMIN_JSON_URL = "/tests/user/local/admin.json";
export const ADMIN_NS = "admin-shared-ns";
export const DEFAULT_ACCOUNT_NS = "default";

const ADMIN_ACCOUNT_KEY = "noneos-admin-account-ns";

const DEFAULT_SERVER_URL = "ws://localhost:8081";
const SERVER_URL_KEY = "noneos-admin-server-url";
const SERVER_HISTORY_KEY = "noneos-admin-server-history";
const MAX_HISTORY = 10;

/**
 * 获取当前使用的登录帐户命名空间
 * @returns {string} ADMIN_NS 或 DEFAULT_ACCOUNT_NS
 */
export function getAdminAccountNamespace() {
  try {
    const ns = localStorage.getItem(ADMIN_ACCOUNT_KEY);
    if (ns === DEFAULT_ACCOUNT_NS) return DEFAULT_ACCOUNT_NS;
  } catch {
    // localStorage 不可用则回退管理员帐户
  }
  return ADMIN_NS;
}

/**
 * 设置登录帐户命名空间
 * @param {string} ns - ADMIN_NS 或 DEFAULT_ACCOUNT_NS
 */
export function setAdminAccountNamespace(ns) {
  try {
    if (ns === DEFAULT_ACCOUNT_NS) {
      localStorage.setItem(ADMIN_ACCOUNT_KEY, DEFAULT_ACCOUNT_NS);
    } else {
      localStorage.removeItem(ADMIN_ACCOUNT_KEY);
    }
  } catch {
    // 忽略写入失败
  }
}

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

function formatUserId(userId) {
  if (!userId) return "";
  if (userId.length <= 8) return userId;
  return `${userId.slice(0, 4)}...${userId.slice(-4)}`;
}

/**
 * 获取两个登录帐户的摘要信息（用于弹窗展示）
 * @returns {Promise<Array<{namespace: string, label: string, userId: string, shortUserId: string}>>}
 */
export async function getAccountSummaries(load) {
  const { getUserInfo } = await load("/nos/user/db.js");
  const { getUser } = await load("/nos/user/main.js");

  const summaries = [];

  // 管理员帐户
  try {
    const adminData = await fetch(ADMIN_JSON_URL).then((r) => r.json());
    const savedAdminInfo = await getUserInfo(ADMIN_NS);
    const adminUserId = savedAdminInfo?.userId || adminData.info?.userId || "";
    summaries.push({
      namespace: ADMIN_NS,
      label: "管理员（导入 key）",
      userId: adminUserId,
      shortUserId: formatUserId(adminUserId),
    });
  } catch (e) {
    summaries.push({
      namespace: ADMIN_NS,
      label: "管理员（导入 key）",
      userId: "",
      shortUserId: "",
    });
  }

  // 本地默认帐户（不存在时自动创建，以便展示 userId）
  try {
    const defaultUser = await getUser(DEFAULT_ACCOUNT_NS);
    const defaultUserId = defaultUser.userId || "";
    summaries.push({
      namespace: DEFAULT_ACCOUNT_NS,
      label: "本地默认用户",
      userId: defaultUserId,
      shortUserId: formatUserId(defaultUserId),
    });
  } catch (e) {
    summaries.push({
      namespace: DEFAULT_ACCOUNT_NS,
      label: "本地默认用户",
      userId: "",
      shortUserId: "",
    });
  }

  return summaries;
}

export async function getAdmin(load) {
  if (_adminUser) return { adminUser: _adminUser, adminInfo: _adminInfo };
  if (_promise) return _promise;

  _promise = (async () => {
    const { AdminUser } = await load("/nos/user/admin-user.js");

    const namespace = getAdminAccountNamespace();

    if (namespace === ADMIN_NS) {
      const { saveUserKeys, saveUserInfo } = await load("/nos/user/db.js");
      const { deleteUser } = await load("/nos/user/main.js");

      const adminData = await fetch(ADMIN_JSON_URL).then((r) => r.json());

      try {
        await deleteUser(ADMIN_NS, { skipConfirm: true });
      } catch (e) {
        /* ignore */
      }
      await saveUserKeys(ADMIN_NS, adminData.keys);
      await saveUserInfo(ADMIN_NS, adminData.info);
    }

    await new Promise((resolve) => setTimeout(resolve, 300));

    const adminUser = new AdminUser(namespace);
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
