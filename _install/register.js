// 这个文件用于快速注册service worker，多用于测试环境使用；
// 正式产品建议使用 main.js 先检查，后执行安装流程
import { registerSw } from "./util.js";

let registration;

try {
  registration = await registerSw("sw.js");
  console.log("Service Worker registered:", registration.scope);
} catch (error) {
  console.error("Service Worker registration failed:", error);
  throw error;
}

export default registration;
