// 这个文件用于快速注册service worker，多用于测试环境使用；
// 正式产品建议使用 main.js 先检查，后执行安装流程
import { register } from "./util.js";

const registration = await register("sw.js");

export default registration;
