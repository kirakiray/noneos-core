(function () {
  'use strict';

  const get = ({ request, path }) => {
    console.log(request, path, 3);
  };

  self.addEventListener("fetch", (event) => {
    const { request } = event;
    const { pathname, origin, searchParams } = new URL(request.url);

    if (/^_/.test(pathname)) {
      return;
    }

    event.respondWith(get({ request, path: pathname }));
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
