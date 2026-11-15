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
  assert.match(styles, /--app-height:\s*100dvh/);
  assert.doesNotMatch(styles, /--app-height:\s*100lvh/);
  assert.match(styles, /html\.viewport-reanchored/);
  assert.match(appScript, /resolveVisibleAppHeight\(/);
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

test('app.mjsが参照する固定IDはindex.htmlに存在する', () => {
  const ids = new Set([...appScript.matchAll(/\bel\('([A-Za-z0-9_-]+)'\)/g)].map((match) => match[1]));
  const missing = [...ids].filter((id) => !indexHtml.includes(`id="${id}"`));
  assert.deepEqual(missing, []);
});

test('固定し直す操作と下書き復元・保存領域・最終バックアップの表示要素がある', () => {
  for (const id of ['relockBtn', 'resetLockBtn', 'draftNotice', 'storagePersistState', 'storageUsage', 'historyBackupStatus', 'historyBackupNotice']) {
    assert.match(indexHtml, new RegExp(`id="${id}"`), id);
  }
});

test('ユーザー制御の値をinnerHTMLで描画しない', () => {
  assert.doesNotMatch(appScript, /innerHTML|insertAdjacentHTML|outerHTML/);
});

test('新規保存の記録日時は固定した瞬間を使う', () => {
  assert.match(appScript, /lockedRefDate\.getTime\(\)/);
  assert.doesNotMatch(appScript, /timestamp: Date\.now\(\)/);
});

test('編集モーダルは枠外タップ・Esc・キャンセルのいずれも破棄確認を通る', () => {
  assert.match(appScript, /el\('editCancelBtn'\)\.addEventListener\('click', requestCloseEditModal\)/);
  assert.match(appScript, /event\.target === el\('editOverlay'\)\) requestCloseEditModal\(\)/);
  assert.match(appScript, /bindDialogKeys\(el\('editDialog'\), requestCloseEditModal\)/);
  assert.match(appScript, /変更を破棄しますか？/);
});

test('端末設定に従うライト／ダークのテーマ色を宣言する', () => {
  assert.match(indexHtml, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: light\)">/i);
  assert.match(indexHtml, /<meta name="theme-color" content="#[0-9a-f]{6}" media="\(prefers-color-scheme: dark\)">/i);
  assert.match(styles, /@media \(prefers-color-scheme: light\)\s*\{\s*:root\s*\{[^}]*color-scheme:\s*light/);
  assert.match(cssRule(':root'), /color-scheme:\s*dark/);
});

test('個別ルールに色を直書きせず、色はルートの変数で定義する', () => {
  const withoutVariableBlocks = styles
    .replace(/:root\s*\{[^}]*\}/g, '')
    .replace(/@media \(prefers-color-scheme: light\)\s*\{\s*\}/g, '');
  assert.doesNotMatch(withoutVariableBlocks, /#[0-9a-f]{3,8}\b|rgba?\(|:\s*white\b/i);
});

test('本文の文字は13px未満にしない', () => {
  assert.doesNotMatch(styles, /font(?:-size)?:\s*(?:[^;]*\s)?(?:9|10|11|12)px/);
});

test('抽出期間の欄は実時刻で入力することを明記する', () => {
  const legends = [...indexHtml.matchAll(/<legend>(抽出期間[^<]*)<\/legend>/g)].map((match) => match[1]);
  assert.equal(legends.length, 2);
  for (const legend of legends) assert.match(legend, /実時刻/);
});

test('CSPはプレビュー用にimg-srcへblob:を足すだけにとどめる', () => {
  const csp = indexHtml.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/);
  assert.ok(csp, 'CSPが必要です');
  const directives = Object.fromEntries(csp[1].split(';').map((part) => part.trim()).filter(Boolean)
    .map((part) => { const [name, ...values] = part.split(/\s+/); return [name, values.join(' ')]; }));
  assert.equal(directives['img-src'], "'self' data: blob:");
  assert.equal(directives['script-src'], "'self'");
  assert.equal(directives['object-src'], "'none'");
  assert.equal(directives['default-src'], "'self'");
  assert.doesNotMatch(csp[1], /unsafe-|frame-src|media-src/);
});

test('添付の選択は許可した種類だけを提示し、SVGやHTMLを含めない', () => {
  const input = indexHtml.match(/<input[^>]*id="attachmentFileInput"[^>]*>/);
  assert.ok(input, '添付用のファイル入力が必要です');
  assert.match(input[0], /\bmultiple\b/);
  const accept = input[0].match(/accept="([^"]+)"/)[1].split(',');
  assert.deepEqual(accept.sort(), ['application/pdf', 'image/heic', 'image/heif', 'image/jpeg', 'image/png', 'image/webp']);
});

test('添付はバックアップ対象外であることと、即時保存であることを明示する', () => {
  assert.match(indexHtml, /id="historyAttachmentNotice"/);
  assert.match(appScript, /全件バックアップに添付ファイルは含まれません/);
  assert.match(indexHtml, /添付ファイルの追加・削除はその場で保存されます/);
});

test('プレビュー用のblob URLは解放する', () => {
  assert.match(appScript, /URL\.createObjectURL\(/);
  const body = (name) => {
    const match = appScript.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
    assert.ok(match, `${name}関数が必要です`);
    return match[0];
  };
  assert.match(body('closeAttachmentPreview'), /URL\.revokeObjectURL\(previewUrl\)/);
  assert.match(body('resetAttachmentPanel'), /closeAttachmentPreview\(\)/);
  assert.match(body('closeEditModal'), /resetAttachmentPanel\(\)/);
  assert.match(body('renderAttachmentList'), /closeAttachmentPreview\(\)/);
  assert.match(body('previewAttachment'), /closeAttachmentPreview\(\)/);
});

test('フォーカストラップは非表示の祖先を持つ要素とリンクを正しく扱う', () => {
  const focusable = appScript.match(/function focusableElements\([\s\S]*?\n\}/);
  assert.ok(focusable);
  assert.match(focusable[0], /a\[href\]/);
  assert.match(focusable[0], /closest\('\[hidden\]'\)/);
});
