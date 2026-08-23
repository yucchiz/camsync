import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [indexHtml, appScript, styles, readme, serviceWorker] = await Promise.all([
  readFile(new URL('../index.html', import.meta.url), 'utf8'),
  readFile(new URL('../app.mjs', import.meta.url), 'utf8'),
  readFile(new URL('../styles.css', import.meta.url), 'utf8'),
  readFile(new URL('../README.md', import.meta.url), 'utf8'),
  readFile(new URL('../sw.js', import.meta.url), 'utf8'),
]);

function cssRule(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = styles.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`));
  assert.ok(match, `${selector} のCSSルールが必要です`);
  return match[1];
}

test('初期表示のバージョンはAPP_VERSIONと一致する', () => {
  const appVersion = appScript.match(/const APP_VERSION = '(\d+\.\d+\.\d+)';/);
  const fallbackVersion = indexHtml.match(/id="appVersion">v(\d+\.\d+(?:\.\d+)?)</);
  const documentedVersion = readme.match(/このソースのバージョンは \*\*v(\d+\.\d+(?:\.\d+)?)\*\*/);

  assert.ok(appVersion, 'APP_VERSIONが必要です');
  assert.ok(fallbackVersion, '初期表示用のバージョンが必要です');
  assert.ok(documentedVersion, 'READMEのソースバージョンが必要です');
  const displayVersion = appVersion[1].replace(/\.0$/, '');
  assert.equal(fallbackVersion[1], displayVersion);
  assert.equal(documentedVersion[1], displayVersion);
});

test('アプリシェルはルートを固定し、本文だけをスクロールさせる', () => {
  const rootRule = cssRule('html, body');
  const appRule = cssRule('.app');
  const bodyRule = cssRule('.app-body');
  const tabRule = cssRule('.tab-bar');

  assert.match(rootRule, /overflow:\s*clip/);
  assert.match(rootRule, /height:\s*var\(--app-height\)/);
  assert.match(appRule, /display:\s*flex/);
  assert.match(appRule, /height:\s*var\(--app-height\)/);
  assert.match(appRule, /overflow:\s*clip/);
  assert.match(bodyRule, /flex:\s*1/);
  assert.match(bodyRule, /min-height:\s*0/);
  assert.match(bodyRule, /overflow-y:\s*auto/);
  assert.match(tabRule, /flex:\s*0 0 auto/);
  assert.doesNotMatch(tabRule, /position:\s*(?:fixed|absolute|sticky)/);
  assert.match(styles, /--app-height:\s*100lvh/);
  assert.match(styles, /html\.viewport-reanchored/);
});

test('画面切替時は本文スクロール位置をリセットする', () => {
  const switchScreen = appScript.match(/function switchScreen\([\s\S]*?\n\}/);

  assert.ok(switchScreen, 'switchScreen関数が必要です');
  assert.match(switchScreen[0], /el\('appBody'\)\.scrollTop = 0;/);
});

test('キーボード終了時は入力前の本文スクロール位置へ戻す', () => {
  assert.match(appScript, /el\('appBody'\)\.scrollTop = keyboardScrollTop;/);
});

test('新しいサービスワーカーはHTTPキャッシュを再検証してアプリシェルを取得する', () => {
  assert.match(
    serviceWorker,
    /APP_SHELL\.map\(\(url\) => new Request\(url, \{ cache: 'reload' \}\)\)/,
  );
  assert.match(serviceWorker, /'\.\/lib\/viewport\.mjs'/);
});
