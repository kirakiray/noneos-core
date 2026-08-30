// dev-bridge 开发模式注入的总开关（可选）：
// 宿主项目在自己的 sw.js 中声明 globalThis.DEV_BRIDGE_ENABLED = true 后，
// 配合 nos-config/system.json 的 devBridge.script 配置才会启用 HTML 注入。
globalThis.DEV_BRIDGE_ENABLED = true;

importScripts("/sw/dist.js");
