import test from 'node:test';
import assert from 'node:assert/strict';

import { describePersistence, formatStorageUsage } from '../lib/storage-info.mjs';

test('永続化の状態を表示用に変換する', () => {
  assert.equal(describePersistence(true).state, 'granted');
  assert.match(describePersistence(true).label, /許可済み/);
  assert.equal(describePersistence(false).state, 'denied');
  assert.match(describePersistence(false).label, /未許可/);
  assert.equal(describePersistence(null).state, 'unsupported');
  assert.equal(describePersistence(undefined).state, 'unsupported');
  assert.match(describePersistence(null).label, /非対応/);
});

test('使用量の目安を整形する', () => {
  assert.equal(formatStorageUsage({ usage: 1536, quota: 1024 * 1024 * 1024 }), '使用量の目安：1.5 KiB / 1.00 GiB');
  assert.equal(formatStorageUsage({ usage: 5 * 1024 * 1024, quota: 100 * 1024 * 1024 }), '使用量の目安：5.0 MiB / 100.0 MiB');
  assert.equal(formatStorageUsage({ usage: 0, quota: 2048 }), '使用量の目安：0 B / 2.0 KiB');
});

test('使用量が取得できない場合は非対応を示す', () => {
  for (const value of [null, undefined, {}, { usage: 'x', quota: 1 }, { usage: -1, quota: 1 }, { usage: NaN, quota: 1 }]) {
    assert.equal(formatStorageUsage(value), '使用量の目安：取得できません');
  }
});

test('上限が不明でも使用量だけ表示する', () => {
  assert.equal(formatStorageUsage({ usage: 2048 }), '使用量の目安：2.0 KiB');
});
