export const swReady = (async () => {
  if ("serviceWorker" in navigator) {
    const registration = await navigator.serviceWorker.register("/sw.js");

    // 等待 Service Worker 成功激活后才返回
    await navigator.serviceWorker.ready;

    if (registration.active.state !== "activated") {
      // 监听 Service Worker 激活事件
      await new Promise((resolve, reject) => {
        registration.active.addEventListener("statechange", () => {
          if (registration.active.state === "activated") {
            console.log("Service Worker activated");
            resolve(registration);
          }
        });
      });
    }
    return registration;
  }
})();
