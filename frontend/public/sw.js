// FictionFlow Service Worker
// Cache strategy:
// - App shell (HTML/CSS/JS): stale-while-revalidate (instant load + bg update)
// - Static assets (icons, fonts): cache-first
// - TTS POST /api/tts: cache-first by request body content. Key = sha256 of
//   {voice, text}. Repeated plays of the same bubble hit the cache before
//   the network, so playback is instant on second click.
// - Other API calls: network-only (data fresh, SSE stream must not cache).
//
// Versi: v3 — bump CACHE_VERSION jika ada breaking change supaya old cache di-purge.

const CACHE_VERSION = 'fictionflow-v3';

// Generic sha256 hex digest of a UTF-8 string. Runs off the main thread via
// subtle.digest; passed through to fetch handler via a Promise.
async function sha256Hex(str) {
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Cache that holds rendered TTS audio bytes. Each entry's key starts with
// tts: followed by the content hash so cache names are stable across reloads.
const TTS_CACHE = 'fictionflow-tts-v3';

const APP_SHELL = [
  '/',
  '/index.html',
  '/story.html',
  '/css/tailwind.output.css',
  '/js/pages/story.page.js',
  '/js/pages/dashboard.page.js',
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
          // Drop old app-shell caches and old TTS caches on the same bump.
          .filter((k) => k !== CACHE_VERSION && k !== TTS_CACHE)
          .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Skip cross-origin (Google Fonts, etc) — biarkan browser handle.
  if (url.origin !== self.location.origin) return;

  // TTS POST /api/tts: read body, compute hash key, check cache, fall back
  // to network. On network success, store the body with the hash key. We
  // accept both 200 (cached body) and any other status so the cache acts
  // purely as a cold-cache accelerator.
  if (req.method === 'POST' && url.pathname === '/api/tts') {
    event.respondWith(handleTtsPost(req));
    return;
  }

  // Skip non-GET (POST/PUT/DELETE + SSE) for everything else.
  if (req.method !== 'GET') return;

  // Skip non-TTS SSE stream (e.g. GET /api/stories/.../messages/tts-latest).
  // Other /api reads are not cached.
  // (No /api/sse route today; this branch is a deliberate future-proof.)

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

async function handleTtsPost(req) {
  let body = null;
  try {
    body = await req.clone().json();
  } catch {
    // Non-JSON body — just forward as-is.
    return fetch(req);
  }
  const text = (body?.text ?? '').toString();
  const voice = (body?.voice ?? '').toString();
  if (!text || !voice) {
    return fetch(req);
  }
  const key = `tts:${voice}:${await sha256Hex(text)}`;
  const cache = await caches.open(TTS_CACHE);

  // Cache hit: serve stored Response directly. Put it through a copy so
  // the SW keeps the cached body intact between calls.
  const cachedResponse = await cache.match(key);
  if (cachedResponse) {
    const headers = new Headers(cachedResponse.headers);
    headers.set('X-Tts-Cache', 'hit');
    return new Response(cachedResponse.body, {
      status: cachedResponse.status,
      statusText: cachedResponse.statusText,
      headers,
    });
  }

  // Cache miss: forward to network. Cache successful MP3 body along with
  // a custom X-Tts-Cache header so the caller knows the body is fresh.
  try {
    const networkResponse = await fetch(req);
    if (networkResponse.ok) {
      const headers = new Headers(networkResponse.headers);
      headers.set('X-Tts-Cache', 'miss');
      const body = await networkResponse.arrayBuffer();
      // Store the same body under the hash key. Response can't be passed
      // through after arrayBuffer() — must rebuild for both cache.put and
      // the return value.
      const cacheableResponse = new Response(body, {
        status: networkResponse.status,
        statusText: networkResponse.statusText,
        headers,
      });
      try {
        await cache.put(key, cacheableResponse.clone());
      } catch {}
      return new Response(body, {
        status: networkResponse.status,
        statusText: networkResponse.statusText,
        headers,
      });
    }
    return networkResponse;
  } catch (err) {
    return new Response(
      JSON.stringify({ success: false, message: 'SW offline and no TTS cache for this bubble.' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

self.addEventListener('message', (event) => {
  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

