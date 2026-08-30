// 反向用例专用 SW：不声明 DEV_BRIDGE_ENABLED 总开关，仅加载 dist.js。
// 用于验证「只有 systemConfig.devBridge 配置、宿主未开启总开关」时注入不生效。
importScripts("/sw/dist.js");
