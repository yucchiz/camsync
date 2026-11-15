const CACHE_PREFIX = 'camsync-';
const CACHE_NAME = 'camsync-v22';
const APP_SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.mjs',
  './lib/result.mjs',
  './lib/time.mjs',
  './lib/record.mjs',
  './lib/markdown.mjs',
  './lib/storage.mjs',
  './lib/backup.mjs',
  './lib/viewport.mjs',
  './lib/attachment.mjs',
  './lib/draft.mjs',
  './lib/safe-storage.mjs',
  './lib/backup-status.mjs',
  './lib/form-errors.mjs',
  './lib/storage-info.mjs',
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
    caches.open(CACHE_NAME).then((cache) => cache.addAll(
      APP_SHELL.map((url) => new Request(url, { cache: 'reload' }))
    ))
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

// 起動URLが ./ でも ./index.html でも、クエリ付きでも、キャッシュ済みの index.html に対応づける。
function isAppEntryUrl(url) {
  const scopeUrl = new URL(self.registration.scope);
  return url.origin === scopeUrl.origin &&
    (url.pathname === scopeUrl.pathname || url.pathname === new URL(APP_ENTRY_URL).pathname);
}

function isNavigationRequest(request) {
  return request.mode === 'navigate' || request.destination === 'document';
}

// アプリシェルはinstall時に作ったこのバージョンのキャッシュだけから返す（cache-first）。
// 稼働中のキャッシュはfetchで上書きしないため、「新しいHTML+古いJS」の混在は起きない。
// キャッシュに無い要求はネットワークへ取りに行くだけで、キャッシュには書き足さない。
async function respondFromAppShell(request) {
  const cache = await caches.open(CACHE_NAME);
  const url = new URL(request.url);
  const key = isAppEntryUrl(url) ? APP_ENTRY_URL : request;
  const cached = await cache.match(key, { ignoreSearch: true });
  if (cached) return cached;

  try {
    return await fetch(request);
  } catch (networkError) {
    const entry = isNavigationRequest(request) ? await cache.match(APP_ENTRY_URL) : undefined;
    if (entry) return entry;
    throw networkError;
  }
}

function isAppRequest(request) {
  if (request.method !== 'GET') return false;

  const requestUrl = new URL(request.url);
  const scopeUrl = new URL(self.registration.scope);
  return requestUrl.origin === scopeUrl.origin && requestUrl.href.startsWith(scopeUrl.href);
}

self.addEventListener('fetch', (event) => {
  if (!isAppRequest(event.request)) return;
  event.respondWith(respondFromAppShell(event.request));
});
