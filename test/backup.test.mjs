import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BACKUP_FORMAT,
  BACKUP_FORMAT_VERSION,
  BACKUP_WARNING_RATIO,
  MAX_BACKUP_BYTES,
  MAX_BACKUP_RECORDS,
  BackupError,
  assessBackupCapacity,
  createBackup,
  createDuplicatePlan,
  createRestorePlan,
  estimateSerializedBackupBytes,
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

test('全件バックアップはiOSの秒付き抽出時刻を分に正規化して通す', async () => {
  const backup = await createBackup([makeRecord({ extractStartTime: '23:50:00', extractEndTime: '00:10:00' })], {
    appVersion: '1.0.0',
    exportedAt: '2026-08-11T06:00:00.000Z',
  });

  assert.equal(backup.records[0].extractStartTime, '23:50');
  assert.equal(backup.records[0].extractEndTime, '00:10');
  assert.equal(backup.records[0].id, 7);
  assert.equal(backup.records[0].timestamp, 1_786_406_445_678);

  const parsed = await parseBackup(serializeBackup(backup));
  assert.equal(parsed.records[0].extractStartTime, '23:50');
  assert.equal(parsed.records[0].extractEndTime, '00:10');
  assert.equal(parsed.records[0].id, 7);
  assert.equal(parsed.records[0].timestamp, 1_786_406_445_678);
});

test('バックアップ容量判定は件数の80%・上限・超過境界を区別する', () => {
  assert.equal(BACKUP_WARNING_RATIO, 0.8);

  const expectations = [
    [7_999, 'normal'],
    [8_000, 'warning'],
    [9_999, 'warning'],
    [10_000, 'limit'],
    [10_001, 'over'],
  ];
  for (const [recordCount, state] of expectations) {
    const capacity = assessBackupCapacity({ recordCount, backupBytes: 0 });
    assert.equal(capacity.level, state);
    assert.deepEqual(capacity.records, {
      current: recordCount,
      max: MAX_BACKUP_RECORDS,
      warningAt: 8_000,
      state,
    });
    assert.equal(capacity.bytes.state, 'normal');
  }
});

test('バックアップ容量判定はUTF-8バイト数の80%・上限・超過境界を区別する', () => {
  const warningAt = MAX_BACKUP_BYTES * BACKUP_WARNING_RATIO;
  const expectations = [
    [warningAt - 1, 'normal'],
    [warningAt, 'warning'],
    [MAX_BACKUP_BYTES - 1, 'warning'],
    [MAX_BACKUP_BYTES, 'limit'],
    [MAX_BACKUP_BYTES + 1, 'over'],
  ];
  for (const [backupBytes, state] of expectations) {
    const capacity = assessBackupCapacity({ recordCount: 0, backupBytes });
    assert.equal(capacity.level, state);
    assert.deepEqual(capacity.bytes, {
      current: backupBytes,
      max: MAX_BACKUP_BYTES,
      warningAt,
      state,
    });
    assert.equal(capacity.records.state, 'normal');
  }
});

test('バックアップ容量判定の全体levelは件数と容量の深刻な方を採用する', () => {
  const capacity = assessBackupCapacity(
    { recordCount: 8, backupBytes: 11 },
    { maxRecords: 10, maxBytes: 10, warningRatio: 0.8 },
  );

  assert.equal(capacity.level, 'over');
  assert.equal(capacity.records.state, 'warning');
  assert.equal(capacity.bytes.state, 'over');
});

test('バックアップ容量判定は不正な値とオプションを拒否する', () => {
  const invalidCases = [
    [{ recordCount: -1, backupBytes: 0 }, undefined],
    [{ recordCount: 0.5, backupBytes: 0 }, undefined],
    [{ recordCount: 0, backupBytes: Number.NaN }, undefined],
    [{ recordCount: 0, backupBytes: 0 }, { maxRecords: 0 }],
    [{ recordCount: 0, backupBytes: 0 }, { maxBytes: -1 }],
    [{ recordCount: 0, backupBytes: 0 }, { warningRatio: 0 }],
    [{ recordCount: 0, backupBytes: 0 }, { warningRatio: 1.01 }],
  ];

  for (const [values, options] of invalidCases) {
    assert.throws(() => assessBackupCapacity(values, options), TypeError);
  }
});

test('推定バイト数は空配列と日本語を含む記録をUTF-8で数える', () => {
  const options = {
    appVersion: '1.0.0',
    exportedAt: '2026-08-11T06:00:00.000Z',
  };
  const emptyBytes = estimateSerializedBackupBytes([], options);
  const asciiBytes = estimateSerializedBackupBytes([
    makeRecord({ location: 'aaa', witnessName: '', notes: '' }),
  ], options);
  const japaneseBytes = estimateSerializedBackupBytes([
    makeRecord({ location: '倉庫', witnessName: '', notes: '' }),
  ], options);

  assert.ok(emptyBytes > 0);
  assert.equal(japaneseBytes - asciiBytes, 3);
});

test('推定バイト数は固定長digestを含む実バックアップ出力と一致する', async () => {
  const records = [makeRecord(), makeRecord({ id: 8, notes: '日本語\n複数行' })];
  const options = {
    appVersion: '1.0.0',
    exportedAt: '2026-08-11T06:00:00.000Z',
  };
  const backup = await createBackup(records, options);
  const actualBytes = new TextEncoder().encode(serializeBackup(backup)).byteLength;

  assert.equal(estimateSerializedBackupBytes(records, options), actualBytes);
});

test('推定バイト数はバックアップ件数上限を超えた履歴でも算出できる', () => {
  const records = Array.from(
    { length: MAX_BACKUP_RECORDS + 1 },
    (_, index) => makeRecord({ id: index + 1 }),
  );

  const bytes = estimateSerializedBackupBytes(records, {
    appVersion: '1.0.0',
    exportedAt: '2026-08-11T06:00:00.000Z',
  });

  assert.ok(Number.isSafeInteger(bytes));
  assert.ok(bytes > 0);
});

test('推定バイト数は多様な記録でも実バックアップ出力と一致する', async () => {
  const records = [
    makeRecord({ id: 1, notes: '' }),
    makeRecord({ id: 2, location: 'quote " backslash \\ tab\t', notes: '絵文字😀\r\n改行' }),
    makeRecord({ id: 3, extractEndDate: '', extractEndTime: '', witnessAge: '' }),
    makeRecord({ id: 40, timestamp: 0, location: '', witnessName: '' }),
  ];
  const options = {
    appVersion: '2.8.0',
    exportedAt: '2026-08-11T06:00:00.000Z',
  };
  const backup = await createBackup(records, options);
  const actualBytes = new TextEncoder().encode(serializeBackup(backup)).byteLength;

  assert.equal(estimateSerializedBackupBytes(records, options), actualBytes);
});

test('推定バイト数はIDが重複する記録を拒否する', () => {
  assert.throws(
    () => estimateSerializedBackupBytes([makeRecord(), makeRecord()], {
      appVersion: '1.0.0',
      exportedAt: '2026-08-11T06:00:00.000Z',
    }),
    (error) => error instanceof BackupError && error.code === 'DUPLICATE_RECORD_ID'
      && error.details.index === 1 && error.details.id === 7,
  );
});

test('parseBackupの上限オプションは不正値をTypeErrorで拒否する', async () => {
  await assert.rejects(
    parseBackup('{}', { maxBytes: 0 }),
    { name: 'TypeError', message: 'maxBytes must be a positive safe integer' },
  );
  await assert.rejects(
    parseBackup('{}', { maxRecords: -1 }),
    { name: 'TypeError', message: 'maxRecords must be a non-negative safe integer' },
  );
  await assert.rejects(
    parseBackup('{}', { maxRecords: 1.5 }),
    { name: 'TypeError', message: 'maxRecords must be a non-negative safe integer' },
  );
});
