import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  StorageError,
  bulkAddRecords,
  openDB,
  replaceAllRecords,
} from '../lib/storage.mjs';

test('既存IndexedDB契約を維持する', () => {
  assert.equal(DB_NAME, 'CamSyncDB');
  assert.equal(DB_VERSION, 1);
  assert.equal(STORE_NAME, 'records');
});

test('IndexedDBを利用できない場合は構造化エラーを返す', async () => {
  await assert.rejects(
    openDB({ indexedDBFactory: {} }),
    (error) => error instanceof StorageError && error.code === 'UNAVAILABLE',
  );
});

test('一括処理はtransaction開始前に入力配列を検証する', async () => {
  await assert.rejects(bulkAddRecords(null), TypeError);
  await assert.rejects(replaceAllRecords([null]), TypeError);
});
