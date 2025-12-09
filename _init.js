if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").then((registration) => {
    console.log("Service Worker registered with scope:", registration.scope);
  });
}
