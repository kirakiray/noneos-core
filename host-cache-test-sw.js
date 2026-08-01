// 测试用 SW：启用 host-cache 功能
// 仅用于 tests/sw/host-cache.sb.html 测试，勿用于生产
globalThis.HOST_CACHE_CONFIG = {
  manifestPath: "/tests/sw/host-cache-test-manifest.json",
};
importScripts("/sw/dist.js");
