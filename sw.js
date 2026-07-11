// Service Worker：離線快取全部靜態資源，讓 PWA 加入主畫面後不需網路也能開啟（掃碼、盤點畫面）。
// 部署指南 §3：每次改版記得把 CACHE_VERSION 往上加一版，否則手機會一直吃到舊快取。
const CACHE_VERSION = "stocktake-v4";

const PRECACHE_URLS = [
  "./",
  "index.html",
  "app.js",
  "config.js",
  "js/db.js",
  "manifest.json",
  "lib/supabase.js",
  "lib/bootstrap.min.css",
  "lib/bootstrap.bundle.min.js",
  "lib/html5-qrcode.min.js",
  "icons/icon-192.png",
  "icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// 靜態資源走 cache-first（離線可用）；Supabase API 呼叫一律不快取，直接放行給網路層處理
// （supabase-js 內部會走 fetch，離線時失敗由 app.js 的離線佇列邏輯接手）。
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) {
    return; // 交給網路（Supabase API 等外部請求）
  }
  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
