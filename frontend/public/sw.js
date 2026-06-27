// FictionFlow Service Worker
// Cache strategy:
// - App shell (HTML/CSS/JS): stale-while-revalidate (instant load + bg update)
// - Static assets (icons, fonts): cache-first
// - API calls: network-only (jangan cache — data fresh, SSE stream must not cache)
//
// Versi: v1 — bump CACHE_VERSION jika ada breaking change supaya old cache di-purge.

const CACHE_VERSION = 'fictionflow-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/story.html',
  '/css/tailwind.output.css',
  '/js/pages/story.page.js',
  '/js/pages/dashboard.page.js',
  '/js/core/api.js',
  '/js/core/themeManager.js',
  '/js/core/eventBus.js',
  '/js/core/ttsQueueManager.js',
  '/js/core/ttsEngine.js',
  '/js/core/markdownRenderer.js',
  '/js/api/apiClient.js',
  '/manifest.webmanifest',
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
  '/robots.txt',
];

// Cache-first static assets yang immutable (icons, manifest).
const STATIC_ASSET_PATHS = new Set([
  '/manifest.webmanifest',
  '/icon.png',
  '/icon-192.png',
  '/icon-512.png',
]);

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then((cache) => cache.addAll(APP_SHELL).catch((err) => {
        // Beberapa resource mungkin 404 di dev (e.g. story.page belum dibuild);
        // jangan fail install karena satu file hilang.
        console.warn('[sw] partial precache error:', err?.message || err);
      }))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((k) => k !== CACHE_VERSION)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip non-GET (POST/PUT/DELETE + SSE) — jangan intercept.
  if (req.method !== 'GET') return;

  // Skip cross-origin (Google Fonts, etc) — biarkan browser handle.
  if (url.origin !== self.location.origin) return;

  // Skip SSE stream (POST /api/.../messages) — even though GET, jangan cache API.
  if (url.pathname.startsWith('/api/')) return;

  // Static assets: cache-first.
  if (STATIC_ASSET_PATHS.has(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) =>
        cached || fetch(req).then((res) => {
          const copy = res.clone();
          caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          return res;
        }).catch(() => cached)
      )
    );
    return;
  }

  // App shell + navigasi: stale-while-revalidate.
  event.respondWith(
    caches.match(req).then((cached) => {
      const networkFetch = fetch(req)
        .then((res) => {
          // Hanya cache successful response + basic (cors ok untuk same-origin).
          if (res.ok && res.type === 'basic') {
            const copy = res.clone();
            caches.open(CACHE_VERSION).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => {
          // Fallback untuk navigasi saat offline: serve index.html.
          if (req.mode === 'navigate') {
            return caches.match('/index.html');
          }
          return cached;
        });
      return cached || networkFetch;
    })
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
