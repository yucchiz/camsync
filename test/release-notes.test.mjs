import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_RELEASE_NOTES,
  MAX_RELEASE_NOTE_LENGTH,
  normalizeReleaseNotes,
} from '../lib/release-notes.mjs';

test('文字列の一覧を前後の空白を除いて返す', () => {
  assert.deepEqual(normalizeReleaseNotes([' 添付に対応 ', '下書き保存']), ['添付に対応', '下書き保存']);
});

test('配列でない値は空の一覧にする', () => {
  for (const value of [undefined, null, 'text', 42, { notes: [] }]) {
    assert.deepEqual(normalizeReleaseNotes(value), []);
  }
});

test('文字列以外と空の項目は除く', () => {
  assert.deepEqual(normalizeReleaseNotes(['有効', 1, null, '', '   ', { text: 'x' }]), ['有効']);
});

test('件数と1件の長さを上限で切る', () => {
  const many = Array.from({ length: MAX_RELEASE_NOTES + 3 }, (_, index) => `項目${index}`);
  assert.equal(normalizeReleaseNotes(many).length, MAX_RELEASE_NOTES);

  const [long] = normalizeReleaseNotes(['あ'.repeat(MAX_RELEASE_NOTE_LENGTH + 10)]);
  assert.equal(long.length, MAX_RELEASE_NOTE_LENGTH);
});

test('改行は空白にして1行にする', () => {
  assert.deepEqual(normalizeReleaseNotes(['1行目\n2行目']), ['1行目 2行目']);
});
