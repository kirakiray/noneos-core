let _adminUser = null;
let _adminInfo = null;
let _promise = null;

const ADMIN_JSON_URL = "/tests/user/local/admin.json";
const ADMIN_NS = "admin-shared-ns";

export const WS_URL = "ws://localhost:8081";

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
