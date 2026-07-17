import { LocalUser } from "./user.js";
import {
  getUserKeys,
  getUserInfo,
  saveUserKeys,
  saveUserInfo,
  closeDbByNamespace,
} from "./db.js";
import {
  encryptWithPassword,
  decryptWithPassword,
} from "../crypto/crypto-aes.js";

const users = new Map();

export const getUser = async (namespace = "default") => {
  let user = null;
  if (users.has(namespace)) {
    user = users.get(namespace);
  } else {
    user = new LocalUser(namespace);
    users.set(namespace, user);
  }

  await user.ready();

  return user;
};

/**
 * 导出用户数据
 * @param {string} namespace - 用户命名空间
 * @param {string} password - 加密密码
 * @returns {Promise<string>} 加密后的用户数据（base64 格式）
 */
export const exportUser = async (namespace, password) => {
  if (!namespace) {
    throw new Error("namespace is required");
  }
  if (!password) {
    throw new Error("password is required");
  }

  const keys = await getUserKeys(namespace);
  if (!keys) {
    throw new Error(`User "${namespace}" not found`);
  }

  const info = await getUserInfo(namespace);

  const exportData = {
    namespace,
    keys,
    info,
    exportTime: Date.now(),
  };

  const jsonData = JSON.stringify(exportData);
  return encryptWithPassword(password, jsonData);
};

/**
 * 导入用户数据
 * @param {string} namespace - 用户命名空间
 * @param {string} encryptedData - 加密的用户数据（base64 格式）
 * @param {string} password - 解密密码
 * @returns {Promise<LocalUser>} 导入的用户实例
 */
export const importUser = async (namespace, encryptedData, password) => {
  if (!namespace) {
    throw new Error("namespace is required");
  }
  if (!encryptedData) {
    throw new Error("encryptedData is required");
  }
  if (!password) {
    throw new Error("password is required");
  }

  // 检查用户是否已存在
  const existingKeys = await getUserKeys(namespace);
  if (existingKeys) {
    throw new Error(`User "${namespace}" already exists`);
  }

  // 解密数据
  const jsonData = await decryptWithPassword(password, encryptedData);
  const importData = JSON.parse(jsonData);

  // 验证数据格式
  if (
    !importData.keys ||
    !importData.keys.publicKey ||
    !importData.keys.privateKey
  ) {
    throw new Error("Invalid import data: missing keys");
  }

  // 保存密钥和用户信息
  await saveUserKeys(namespace, importData.keys);
  if (importData.info) {
    await saveUserInfo(namespace, importData.info);
  }

  // 返回用户实例
  return getUser(namespace);
};

/**
 * 删除用户
 * @param {string} namespace - 用户命名空间
 * @param {Object} options - 可选参数
 * @param {boolean} options.skipConfirm - 跳过确认提示，直接删除
 * @returns {Promise<boolean>} 删除成功返回 true，取消返回 false
 */
export const deleteUser = async (namespace, options = {}) => {
  if (!namespace) {
    throw new Error("namespace is required");
  }

  // 检查用户是否存在
  const keys = await getUserKeys(namespace);
  if (!keys) {
    throw new Error(`User "${namespace}" not found`);
  }

  const { skipConfirm = false } = options;

  // 如果不跳过确认，显示确认对话框
  if (!skipConfirm) {
    // 获取用户语言
    const lang = navigator.language || navigator.userLanguage;
    const isZh = lang.startsWith("zh");
    const isJa = lang.startsWith("ja");

    // 根据语言选择提示文本
    let confirm1Msg, confirm2Msg;

    if (isZh) {
      confirm1Msg = `确定要删除用户 "${namespace}" 吗？\n\n警告：此操作不可恢复，所有用户数据将被永久删除！`;
      confirm2Msg = `再次确认：您真的要删除用户 "${namespace}" 吗？\n\n此操作将永久删除：\n- 用户密钥对\n- 用户信息\n- 所有证书\n\n删除后无法恢复，请谨慎操作！`;
    } else if (isJa) {
      confirm1Msg = `ユーザー "${namespace}" を削除してもよろしいですか？\n\n警告：この操作は取り消せません。すべてのユーザーデータが完全に削除されます！`;
      confirm2Msg = `再確認：本当にユーザー "${namespace}" を削除しますか？\n\nこの操作により以下が完全に削除されます：\n- ユーザー鍵ペア\n- ユーザー情報\n- すべての証明書\n\n削除後は復元できません。慎重に操作してください！`;
    } else {
      // 默认英语
      confirm1Msg = `Are you sure you want to delete user "${namespace}"?\n\nWarning: This action cannot be undone. All user data will be permanently deleted!`;
      confirm2Msg = `Confirm again: Do you really want to delete user "${namespace}"?\n\nThis action will permanently delete:\n- User key pair\n- User information\n- All certificates\n\nThis cannot be undone. Please proceed with caution!`;
    }

    // 第一次确认
    const confirm1 = confirm(confirm1Msg);
    if (!confirm1) {
      return false;
    }

    // 第二次确认
    const confirm2 = confirm(confirm2Msg);
    if (!confirm2) {
      return false;
    }
  }

  // 如果内存中已有 LocalUser 实例，先停用其埋点并断开 WebSocket
  // 否则后台的 traffic.record / 服务器连接会持续通过 getSharedDb 重新打开数据库，
  // 导致 indexedDB.deleteDatabase 被 onblocked 拦截。
  const cachedUser = users.get(namespace);
  if (cachedUser) {
    try {
      cachedUser.traffic.setEnabled(false);
    } catch {
      // 忽略清理错误
    }
    try {
      cachedUser.server.disconnectAll();
    } catch {
      // 忽略清理错误
    }
    try {
      await cachedUser.traffic.flush();
    } catch {
      // 忽略清理错误
    }
    users.delete(namespace);
  }

  // 关闭缓存中的数据库连接
  closeDbByNamespace(namespace);

  // 删除数据库
  return new Promise((resolve, reject) => {
    const dbName = `nos_user_${namespace}`;

    // Safari 需要延迟确保事务完全结束
    const doDelete = () => {
      const request = indexedDB.deleteDatabase(dbName);

      request.onsuccess = () => {
        // 从内存缓存中移除
        users.delete(namespace);
        resolve(true);
      };

      request.onerror = () => {
        reject(new Error(`Failed to delete database for user "${namespace}"`));
      };

      request.onblocked = () => {
        reject(
          new Error(
            `Database deletion blocked for user "${namespace}". Please close all connections and try again.`,
          ),
        );
      };
    };

    setTimeout(doDelete, 100);
  });
};
