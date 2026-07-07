// Minimal service worker: enough for installability ("Add to Home Screen"),
// deliberately no caching of pages or API responses — Jarvis data is live
// and local, and a stale finance dashboard is worse than a spinner.
self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Network passthrough. The handler must exist for install criteria.
  event.respondWith(fetch(event.request));
});
