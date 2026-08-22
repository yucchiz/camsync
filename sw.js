const CACHE_PREFIX = 'camsync-';
const CACHE_NAME = 'camsync-v11';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.mjs',
  './lib/time.mjs',
  './lib/record.mjs',
  './lib/markdown.mjs',
  './lib/storage.mjs',
  './lib/backup.mjs',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-192.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png'
];

const APP_ENTRY_URL = new URL('./index.html', self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys
          .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data?.type !== 'SKIP_WAITING') return;
  event.waitUntil(self.skipWaiting());
});

async function fetchAndCache(request, cache) {
  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone());
  }
  return response;
}

// HTML/ナビゲーションは network-first。ネットワーク障害時だけ現行キャッシュへ戻す。
async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    return await fetchAndCache(request, cache);
  } catch (networkError) {
    const cached = await cache.match(request) || await cache.match(APP_ENTRY_URL);
    if (cached) return cached;
    throw networkError;
  }
}

// 静的アセットは stale-while-revalidate。キャッシュがあればオフラインでも即時に返す。
async function staleWhileRevalidate(event) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(event.request);
  const network = fetchAndCache(event.request, cache);

  if (!cached) return network;

  // キャッシュ済みなら通信失敗は想定内。更新処理をSWの寿命に紐付ける。
  event.waitUntil(network.catch(() => undefined));
  return cached;
}

function isAppRequest(request) {
  if (request.method !== 'GET') return false;

  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  return requestUrl.origin === scopeUrl.origin && requestUrl.href.startsWith(scopeUrl.href);
}

self.addEventListener('fetch', (event) => {
  if (!isAppRequest(event.request)) return;

  const isNavigation =
    event.request.mode === 'navigate' ||
    event.request.destination === 'document';

  event.respondWith(
    isNavigation ? networkFirst(event.request) : staleWhileRevalidate(event)
  );
});
