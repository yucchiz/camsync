import assert from 'node:assert/strict';
import test from 'node:test';

import { createKeyboardViewportTracker } from '../lib/viewport.mjs';

test('キーボード表示中はvisual viewportのパンを相殺しない', () => {
  const tracker = createKeyboardViewportTracker(844);

  assert.equal(tracker.focus(844), true);
  assert.equal(tracker.focus(500), false);

  assert.deepEqual(tracker.update({ height: 500, offsetTop: 344 }), {
    keyboardActive: true,
    offsetTop: 0,
  });
});

test('キーボード終了時は残留offsetTopをアプリ再アンカー用に返す', () => {
  const tracker = createKeyboardViewportTracker(844);

  tracker.focus(844);
  tracker.update({ height: 500, offsetTop: 344 });

  assert.deepEqual(tracker.update({ height: 844, offsetTop: 344 }), {
    keyboardActive: false,
    offsetTop: 344,
  });
  assert.deepEqual(tracker.update({ height: 844, offsetTop: 0 }), {
    keyboardActive: false,
    offsetTop: 0,
  });
});

test('blur後はviewportの高さが戻らなくても残留offsetTopを返す', () => {
  const tracker = createKeyboardViewportTracker(844);

  tracker.focus(844);
  tracker.update({ height: 500, offsetTop: 344 });
  tracker.blur();

  assert.deepEqual(tracker.update({ height: 500, offsetTop: 344 }), {
    keyboardActive: false,
    offsetTop: 344,
  });
});

test('不正なviewport値は安全な値へ丸める', () => {
  const tracker = createKeyboardViewportTracker(Number.NaN);

  tracker.focus(Number.NaN);

  assert.deepEqual(tracker.update({ height: Number.NaN, offsetTop: -20 }), {
    keyboardActive: true,
    offsetTop: 0,
  });
  tracker.blur();
  assert.deepEqual(tracker.update({ height: 0, offsetTop: Number.NaN }), {
    keyboardActive: false,
    offsetTop: 0,
  });
});
