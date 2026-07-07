/* FableCut service worker — makes the editor installable and available offline.
   Only the static app shell is cached (network-first, so it stays fresh online).
   Live data (project, media, library, exports, SSE) is never intercepted. */
const CACHE = "fablecut-shell-v1";
const SHELL = [
  "/", "/index.html", "/style.css", "/app.js",
  "/manifest.webmanifest", "/favicon.svg",
  "/icons/icon-192.png", "/icons/icon-512.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // Only handle same-origin GETs. Everything else goes straight to the network.
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  // Never touch live data, streams, or heavy media.
  if (/^\/(api|media|exports|library)\//.test(url.pathname)) return;

  // Network-first for the shell; fall back to cache when offline.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(e.request).then((r) => r || caches.match("/index.html")))
  );
});
