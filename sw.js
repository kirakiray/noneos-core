(function () {
  'use strict';

  self.addEventListener("fetch", (event) => {
    const { request } = event;
    const { pathname, origin, searchParams } = new URL(request.url);

    if (/^_/.test(pathname)) {
      return;
    }

    //   event.respondWith((async () => {})());
  });

  self.addEventListener("install", () => {
    self.skipWaiting();
    console.log("NoneOS installation successful");
  });

  self.addEventListener("activate", () => {
    self.clients.claim();
    console.log("NoneOS server activation successful");
  });

})();
