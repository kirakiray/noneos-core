import toast from "https://cdn.jsdelivr.net/gh/ofajs/senti-ui@latest/packages/snackbar/toast.js";

let _adminUser = null;
let _adminInfo = null;
let _promise = null;

const DEFAULT_SERVER_URL = "http://127.0.0.1:8082/ctrl-9f2a";
const SERVER_URL_KEY = "noneos-admin-server-url";
const SERVER_HISTORY_KEY = "noneos-admin-server-history";
const TOKENS_KEY = "noneos-admin-tokens";
const MAX_HISTORY = 10;

/**
 * 管理员 HTTP 客户端
 * 通过独立的 admin HTTP 接口（随机路径 + Bearer Token + 全 POST）与管理服务器交互，
 * 不再依赖 nos/user 的 WebSocket 用户体系。
 */
class AdminHttpClient {
  /** @type {string} 管理 API 基础地址（含路径前缀），如 https://example.com/ctrl-x7k2m9 */
  #baseUrl = "";
  /** @type {string} Bearer Token */
  #token = "";

  constructor(baseUrl, token) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
    this.#token = token;
  }

  /**
   * 发送管理命令并等待响应
   * @param {string} action - 管理操作名称
   * @param {Object} extra - 额外参数（snake_case）
   * @returns {Promise<Object>} 管理命令响应（与原 admin_response 同构）
   */
  async #command(action, extra = {}) {
    let resp;
    try {
      resp = await fetch(this.#baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#token}`,
        },
        body: JSON.stringify({ action, ...extra }),
      });
    } catch (err) {
      throw new Error(`无法连接管理接口（${this.#baseUrl}）：${err?.message || err}`);
    }

    if (resp.status === 404) {
      throw new Error("管理接口返回 404：接口路径或 Token 不正确");
    }
    if (resp.status === 429) {
      throw new Error("请求过于频繁，已被管理接口限流，请稍后重试");
    }
    if (!resp.ok) {
      let message = `HTTP ${resp.status}`;
      try {
        const data = await resp.json();
        if (data?.message) message = data.message;
      } catch {
        /* ignore */
      }
      throw new Error(message);
    }

    return resp.json();
  }

  // ===== 与旧 AdminUser 保持兼容的方法签名（首参 url 被忽略）=====

  async listUsers(_url, { page = 1, pageSize = 20 } = {}) {
    return this.#command("list_users", { page, page_size: pageSize });
  }

  async listUserGroups(_url, { page = 1, pageSize = 20 } = {}) {
    return this.#command("list_user_groups", { page, page_size: pageSize });
  }

  async listAllUsers(_url, { page = 1, pageSize = 20 } = {}) {
    return this.#command("list_all_users", { page, page_size: pageSize });
  }

  async disconnectUser(_url, userId) {
    return this.#command("disconnect_user", { user_id: userId });
  }

  async disconnectSession(_url, userId, sessionId) {
    return this.#command("disconnect_session", { user_id: userId, session_id: sessionId });
  }

  async getSystemInfo(_url) {
    return this.#command("get_system_info");
  }

  async getTrafficStats(_url, { limit } = {}) {
    return this.#command("get_traffic_stats", { limit });
  }

  async getTrafficHistory(_url, { fromMs, userId, page = 1, pageSize = 20 } = {}) {
    return this.#command("get_traffic_history", {
      from_ms: fromMs,
      page,
      page_size: pageSize,
      user_id: userId,
    });
  }

  async getSystemStatsHistory(_url, { limit = 60 } = {}) {
    return this.#command("get_system_stats_history", { limit });
  }

  async setUserRelayQuota(_url, userId, quotaBytes) {
    return this.#command("set_user_relay_quota", {
      user_id: userId,
      quota_bytes: quotaBytes,
    });
  }

  async getUserRelayQuota(_url, userId) {
    if (Array.isArray(userId)) {
      return this.#command("get_user_relay_quota", { user_ids: userId });
    }
    return this.#command("get_user_relay_quota", { user_id: userId });
  }

  async getGlobalRelayQuota(_url) {
    return this.#command("get_global_relay_quota");
  }
}

/**
 * 获取当前管理应用连接的服务器地址（管理 API 基础地址，含路径前缀）
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
 * 设置当前管理应用连接的服务器地址
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
 * 获取已保存的服务器地址历史列表
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
 * 从历史列表中移除指定地址（同时清理对应的 Token）
 * @param {string} url
 */
export function removeServerHistory(url) {
  const list = getServerHistory().filter((u) => u !== url);
  try {
    localStorage.setItem(SERVER_HISTORY_KEY, JSON.stringify(list));
    const tokens = getTokens();
    if (tokens[url] !== undefined) {
      delete tokens[url];
      saveTokens(tokens);
    }
  } catch {
    // 忽略写入失败
  }
}

// ===== Token 管理（按服务器地址分别保存）=====

function getTokens() {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    if (raw) {
      const map = JSON.parse(raw);
      if (map && typeof map === "object") return map;
    }
  } catch {
    // ignore
  }
  return {};
}

function saveTokens(map) {
  try {
    localStorage.setItem(TOKENS_KEY, JSON.stringify(map));
  } catch {
    // ignore
  }
}

/**
 * 获取指定服务器地址对应的 Token
 * @param {string} url
 * @returns {string}
 */
export function getServerToken(url) {
  return getTokens()[url] || "";
}

/**
 * 设置指定服务器地址对应的 Token
 * @param {string} url
 * @param {string} token
 */
export function setServerToken(url, token) {
  if (!url) return;
  const tokens = getTokens();
  if (token) {
    tokens[url] = token;
  } else {
    delete tokens[url];
  }
  saveTokens(tokens);
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

/**
 * 获取管理员 HTTP 客户端（单例）
 * 需要先通过 getCurrentServerUrl / setServerToken 配置好服务器地址与 Token
 * @returns {Promise<{adminUser: AdminHttpClient, adminInfo: {userId: string, username: string}}>}
 */
export async function getAdmin() {
  if (_adminUser) return { adminUser: _adminUser, adminInfo: _adminInfo };
  if (_promise) return _promise;

  _promise = (async () => {
    const url = getCurrentServerUrl();
    const token = getServerToken(url);
    if (!token) {
      _promise = null;
      throw new Error(`未配置服务器 ${url} 的管理 Token，请点击左下角 🌐 修改配置`);
    }

    _adminUser = new AdminHttpClient(url, token);
    _adminInfo = {
      userId: "",
      username: "Admin",
    };

    return { adminUser: _adminUser, adminInfo: _adminInfo };
  })();

  return _promise;
}
