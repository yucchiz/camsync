import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BackupError,
  createBackup,
  createDuplicatePlan,
  createRestorePlan,
  parseBackup,
  serializeBackup,
} from '../lib/backup.mjs';

function makeRecord(overrides = {}) {
  return {
    id: 7,
    timestamp: 1_786_406_445_678,
    refTime: '12:34:05',
    camTime: '12:36:05',
    diffSec: 120,
    direction: 'ahead',
    displayVal: '+2分0秒',
    location: '第一倉庫',
    viewDate: '2026-08-11',
    extractDate: '2026-08-10',
    extractStartTime: '23:50',
    extractEndDate: '2026-08-11',
    extractEndTime: '00:10',
    witnessName: '確認者',
    witnessAge: '40',
    notes: '夜間確認',
    ...overrides,
  };
}

test('全件バックアップはIDとミリ秒timestampを保ったまま往復する', async () => {
  const backup = await createBackup([makeRecord()], {
    appVersion: '1.0.0',
    exportedAt: '2026-08-11T06:00:00.000Z',
  });

  assert.equal(backup.format, BACKUP_FORMAT);
  assert.equal(backup.formatVersion, BACKUP_FORMAT_VERSION);
  assert.match(backup.integrity.digest, /^[0-9a-f]{64}$/);

  const parsed = await parseBackup(serializeBackup(backup));
  assert.equal(parsed.records[0].id, 7);
  assert.equal(parsed.records[0].timestamp, 1_786_406_445_678);
  assert.deepEqual(parsed.records, [makeRecord()]);
});

test('payloadの改変はSHA-256不一致として拒否する', async () => {
  const backup = await createBackup([makeRecord()], {
    appVersion: '1.0.0',
    exportedAt: '2026-08-11T06:00:00.000Z',
  });
  backup.records[0].notes = '改変';

  await assert.rejects(
    parseBackup(JSON.stringify(backup)),
    (error) => error instanceof BackupError && error.code === 'INTEGRITY_MISMATCH',
  );
});

test('未対応formatVersionは書き込み前検査で拒否する', async () => {
  const backup = await createBackup([makeRecord()], {
    appVersion: '1.0.0',
    exportedAt: '2026-08-11T06:00:00.000Z',
  });
  backup.formatVersion = 2;

  await assert.rejects(
    parseBackup(JSON.stringify(backup)),
    (error) => error instanceof BackupError && error.code === 'UNSUPPORTED_VERSION',
  );
});

test('入力サイズとレコード件数の上限をpreflightで強制する', async () => {
  await assert.rejects(
    parseBackup('12345678901', { maxBytes: 10 }),
    (error) => error instanceof BackupError && error.code === 'FILE_TOO_LARGE',
  );

  const backup = await createBackup([makeRecord(), makeRecord({ id: 8 })], {
    appVersion: '1.0.0',
    exportedAt: '2026-08-11T06:00:00.000Z',
  });
  await assert.rejects(
    parseBackup(JSON.stringify(backup), { maxRecords: 1 }),
    (error) => error instanceof BackupError && error.code === 'TOO_MANY_RECORDS',
  );
});

test('未知フィールドや不正なrecordはホワイトリスト検査で拒否する', async () => {
  await assert.rejects(
    createBackup([makeRecord({ remoteToken: 'secret' })], {
      appVersion: '1.0.0',
      exportedAt: '2026-08-11T06:00:00.000Z',
    }),
    (error) => error instanceof BackupError && error.code === 'INVALID_RECORD',
  );

  await assert.rejects(
    createBackup([makeRecord({ timestamp: Number.NaN })], {
      appVersion: '1.0.0',
      exportedAt: '2026-08-11T06:00:00.000Z',
    }),
    (error) => error instanceof BackupError && error.code === 'INVALID_RECORD',
  );
});

test('全件置換で上書きを起こす欠落IDと重複IDをpreflightで拒否する', async () => {
  await assert.rejects(
    createBackup([makeRecord({ id: undefined })], {
      appVersion: '1.0.0',
      exportedAt: '2026-08-11T06:00:00.000Z',
    }),
    (error) => error instanceof BackupError && error.code === 'INVALID_RECORD',
  );

  await assert.rejects(
    createBackup([makeRecord({ id: 7 }), makeRecord({ id: 7, notes: '別記録' })], {
      appVersion: '1.0.0',
      exportedAt: '2026-08-11T06:00:00.000Z',
    }),
    (error) => error instanceof BackupError && error.code === 'DUPLICATE_RECORD_ID',
  );
});

test('Markdown由来の重複比較ではtimestampを分単位に揃えIDを無視する', () => {
  const existing = [makeRecord({ id: 1, timestamp: 1_786_406_401_000 })];
  const incoming = [
    makeRecord({ id: undefined, timestamp: 1_786_406_459_999 }),
    makeRecord({ id: undefined, timestamp: 1_786_406_459_999, notes: '別内容' }),
  ];

  const plan = createDuplicatePlan(incoming, existing, { timestampPrecision: 'minute' });

  assert.equal(plan.additions.length, 1);
  assert.equal(plan.duplicates.length, 1);
  assert.equal(plan.duplicates[0].sourceIndex, 0);
  assert.equal(plan.duplicates[0].matchedExistingId, 1);
});

test('追加復元は既存・入力内重複を除き、置換復元は全件を保持する', () => {
  const existing = [makeRecord({ id: 1 })];
  const duplicate = makeRecord({ id: 20 });
  const fresh = makeRecord({ id: 21, notes: '別記録' });

  const merge = createRestorePlan([duplicate, fresh, { ...fresh, id: 22 }], existing, {
    mode: 'merge',
  });
  assert.deepEqual(merge.records.map((record) => record.notes), ['別記録']);
  assert.equal(merge.duplicates.length, 2);
  assert.equal('id' in merge.records[0], false);

  const replace = createRestorePlan([duplicate, fresh], existing, { mode: 'replace' });
  assert.deepEqual(replace.records, [duplicate, fresh]);
  assert.equal(replace.duplicates.length, 0);
});
