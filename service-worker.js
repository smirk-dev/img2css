/* img2css — service worker for offline use.
   Caches the static app shell so the tool runs with no network. The app
   itself is 100% client-side, so once cached it works fully offline. */
"use strict";

var CACHE = "img2css-v1";
var SHELL = [
  "./",
  "./index.html",
  "./css/terminal.css",
  "./js/converter.js",
  "./js/commands.js",
  "./js/terminal.js",
  "./js/worker.js",
  "./manifest.json",
  "./icon.svg",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) { return c.addAll(SHELL); }).then(function () {
      return self.skipWaiting();
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) { if (k !== CACHE) return caches.delete(k); }));
    }).then(function () { return self.clients.claim(); })
  );
});

// cache-first for the app shell, network-fallback for everything else
self.addEventListener("fetch", function (e) {
  if (e.request.method !== "GET") return;
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request).then(function (res) {
        return res;
      }).catch(function () { return hit; });
    })
  );
});
