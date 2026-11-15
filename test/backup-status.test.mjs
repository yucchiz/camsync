import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKUP_META_KEY,
  createBackupMeta,
  describeBackupStatus,
  loadBackupMeta,
  parseBackupMeta,
  saveBackupMeta
} from '../lib/backup-status.mjs';

const BACKED_UP_AT = new Date(2026, 10, 15, 9, 5, 30).getTime();

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    map
  };
}

test('バックアップ情報は直列化して往復できる', () => {
  const storage = memoryStorage();
  assert.equal(saveBackupMeta(storage, createBackupMeta({ backedUpAt: BACKED_UP_AT, recordCount: 12 })), true);
  assert.deepEqual(loadBackupMeta(storage), { backedUpAt: BACKED_UP_AT, recordCount: 12 });
});

test('壊れたバックアップ情報は未実施として扱う', () => {
  for (const raw of [null, '', '{', '[]', '{"backedUpAt":"x","recordCount":1}', '{"backedUpAt":1,"recordCount":-1}', '{"backedUpAt":1.5,"recordCount":1}']) {
    assert.equal(parseBackupMeta(raw), null, String(raw));
  }
});

test('ストレージが使えなくても例外を投げない', () => {
  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); }
  };
  assert.equal(loadBackupMeta(throwing), null);
  assert.equal(saveBackupMeta(throwing, createBackupMeta({ backedUpAt: 1, recordCount: 1 })), false);
  assert.equal(loadBackupMeta(null), null);
  assert.equal(saveBackupMeta(null, createBackupMeta({ backedUpAt: 1, recordCount: 1 })), false);
  assert.ok(BACKUP_META_KEY);
});

test('未実施で記録がある場合は注意を出す', () => {
  const status = describeBackupStatus(null, 3);
  assert.equal(status.label, '最終バックアップ：未実施');
  assert.equal(status.addedSince, null);
  assert.equal(status.needsAttention, true);
  assert.match(status.notice, /未実施/);
  assert.match(status.confirmNote, /未実施/);
});

test('記録がなければ未実施でも注意しない', () => {
  const status = describeBackupStatus(null, 0);
  assert.equal(status.label, '最終バックアップ：未実施');
  assert.equal(status.needsAttention, false);
  assert.equal(status.notice, '');
});

test('前回から追加がある場合は件数と注意を出す', () => {
  const status = describeBackupStatus({ backedUpAt: BACKED_UP_AT, recordCount: 10 }, 13);
  assert.equal(status.label, '最終バックアップ：2026/11/15 09:05（その後 3 件追加）');
  assert.equal(status.addedSince, 3);
  assert.equal(status.needsAttention, true);
  assert.match(status.confirmNote, /3件追加/);
});

test('追加がなければ注意しない', () => {
  const status = describeBackupStatus({ backedUpAt: BACKED_UP_AT, recordCount: 10 }, 10);
  assert.equal(status.label, '最終バックアップ：2026/11/15 09:05（その後の追加なし）');
  assert.equal(status.addedSince, 0);
  assert.equal(status.needsAttention, false);
  assert.equal(status.notice, '');
});

test('バックアップ後に件数が減った場合は追加0件として扱う', () => {
  const status = describeBackupStatus({ backedUpAt: BACKED_UP_AT, recordCount: 10 }, 4);
  assert.equal(status.addedSince, 0);
  assert.equal(status.needsAttention, false);
});
