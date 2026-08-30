// dev-bridge 注入探针脚本：测试时作为 devBridge.script 的注入目标。
// 通过 self.__bridgeInjected 标记自身已被执行，并记录是否以 async 方式加载。
self.__bridgeInjected = true;
self.__bridgeAsync = !!(document.currentScript && document.currentScript.async);
