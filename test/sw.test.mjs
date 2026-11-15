import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../sw.js', import.meta.url), 'utf8');
const SCOPE = 'https://example.test/camsync/';

// sw.js を最小限のServiceWorkerグローバルでNode上に読み込む。
function loadServiceWorker({ network }) {
  const listeners = {};
  const stores = new Map();
  const puts = [];

  const openCache = (name) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const store = stores.get(name);
    return {
      async addAll(requests) {
        for (const request of requests) store.set(new URL(request.url, SCOPE).href, `shell:${request.url}`);
      },
      async put(request, response) {
        puts.push(request.url);
        store.set(request.url, response);
      },
      async match(request, options = {}) {
        const href = typeof request === 'string' ? request : request.url;
        if (store.has(href)) return store.get(href);
        if (options.ignoreSearch) {
          const url = new URL(href);
          url.search = '';
          return store.get(url.href);
        }
        return undefined;
      }
    };
  };

  const context = {
    URL,
    Request: class { constructor(url, init) { this.url = new URL(url, SCOPE).href; Object.assign(this, init); } },
    self: {
      registration: { scope: SCOPE },
      addEventListener: (type, handler) => { listeners[type] = handler; },
      skipWaiting: async () => {},
      clients: { claim: async () => {} }
    },
    caches: { open: async (name) => openCache(name), keys: async () => [...stores.keys()], delete: async () => true },
    fetch: network
  };
  vm.runInNewContext(source, context);

  return {
    puts,
    async install() {
      let work;
      listeners.install({ waitUntil: (promise) => { work = promise; } });
      await work;
    },
    async request(url, init = {}) {
      let response;
      let handled = false;
      listeners.fetch({
        request: { url, method: 'GET', mode: 'cors', destination: '', ...init },
        respondWith: (promise) => { handled = true; response = promise; }
      });
      return handled ? response : undefined;
    }
  };
}

test('ナビゲーションは ./ ・index.html・クエリ付きのどれでもキャッシュ済みindex.htmlを返す', async () => {
  const worker = loadServiceWorker({ network: async () => { throw new Error('offline'); } });
  await worker.install();
  for (const url of [SCOPE, `${SCOPE}index.html`, `${SCOPE}?source=pwa`, `${SCOPE}index.html?x=1`]) {
    const response = await worker.request(url, { mode: 'navigate', destination: 'document' });
    assert.equal(response, `shell:${new URL('./index.html', SCOPE).href}`, url);
  }
});

test('アプリシェルのアセットはネットワークを使わず現行キャッシュから返し、上書きもしない', async () => {
  let fetched = 0;
  const worker = loadServiceWorker({ network: async () => { fetched += 1; return { ok: true }; } });
  await worker.install();
  const response = await worker.request(`${SCOPE}app.mjs`);
  assert.equal(response, `shell:${new URL('./app.mjs', SCOPE).href}`);
  assert.equal(fetched, 0);
  assert.deepEqual(worker.puts, []);
});

test('キャッシュに無い要求だけネットワークへ取りに行き、キャッシュへは書き足さない', async () => {
  const fresh = { ok: true };
  const worker = loadServiceWorker({ network: async () => fresh });
  await worker.install();
  assert.equal(await worker.request(`${SCOPE}unknown.json`), fresh);
  assert.deepEqual(worker.puts, []);
});

test('スコープ外・別オリジン・GET以外は処理しない', async () => {
  const worker = loadServiceWorker({ network: async () => ({}) });
  await worker.install();
  assert.equal(await worker.request('https://example.test/other/app.mjs'), undefined);
  assert.equal(await worker.request('https://cdn.test/camsync/app.mjs'), undefined);
  assert.equal(await worker.request(`${SCOPE}app.mjs`, { method: 'POST' }), undefined);
});

test('オフラインでキャッシュに無い静的アセットは失敗し、未知のナビゲーションはindex.htmlへ戻す', async () => {
  const worker = loadServiceWorker({ network: async () => { throw new Error('offline'); } });
  await worker.install();
  await assert.rejects(worker.request(`${SCOPE}unknown.json`), /offline/);
  const response = await worker.request(`${SCOPE}other-page`, { mode: 'navigate', destination: 'document' });
  assert.equal(response, `shell:${new URL('./index.html', SCOPE).href}`);
});

// app.mjs から静的 import を再帰的にたどり、読み込まれるモジュールの一覧を返す。
async function collectImportedModules(entry) {
  const root = new URL('../', import.meta.url);
  const seen = new Set();
  const queue = [entry];
  while (queue.length > 0) {
    const path = queue.shift();
    if (seen.has(path)) continue;
    seen.add(path);
    const code = await readFile(new URL(path, root), 'utf8');
    for (const match of code.matchAll(/(?:^|\n)\s*(?:import|export)\s[^;]*?from\s*'(\.{1,2}\/[^']+)'/g)) {
      const resolved = new URL(match[1], new URL(path, root)).href.slice(root.href.length);
      queue.push(resolved);
    }
  }
  return [...seen];
}

function appShellEntries() {
  const list = source.match(/const APP_SHELL = \[([\s\S]*?)\];/);
  assert.ok(list, 'APP_SHELL が必要です');
  return [...list[1].matchAll(/'([^']+)'/g)].map((match) => match[1].replace(/^\.\//, ''));
}

test('APP_SHELL はapp.mjsから読み込まれるすべてのモジュールを含む', async () => {
  const modules = await collectImportedModules('app.mjs');
  assert.ok(modules.includes('lib/attachment.mjs'), 'storage.mjs 経由の import もたどる');
  const shell = new Set(appShellEntries());
  const missing = modules.filter((path) => !shell.has(path));
  assert.deepEqual(missing, []);
});

test('APP_SHELL のlibモジュールはすべて実在する', async () => {
  const libs = appShellEntries().filter((path) => path.startsWith('lib/'));
  for (const path of libs) {
    await assert.doesNotReject(readFile(new URL(`../${path}`, import.meta.url)), path);
  }
});
