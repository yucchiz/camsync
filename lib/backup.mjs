import { RECORD_KEYS, canonicalizeRecord, validateRecord } from './record.mjs';

export const BACKUP_FORMAT = 'camsync-backup';
export const BACKUP_FORMAT_VERSION = 1;
export const BACKUP_DATABASE_SCHEMA_VERSION = 1;
export const BACKUP_CANONICALIZATION = 'camsync-backup-v1';
export const MAX_BACKUP_BYTES = 10 * 1024 * 1024;
export const MAX_BACKUP_RECORDS = 10_000;
export const BACKUP_WARNING_RATIO = 0.8;

const BACKUP_KEYS = [
  'format',
  'formatVersion',
  'databaseSchemaVersion',
  'exportedAt',
  'appVersion',
  'records',
  'integrity',
];
const INTEGRITY_KEYS = ['algorithm', 'canonicalization', 'digest'];

export class BackupError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'BackupError';
    this.code = code;
    if (options.details !== undefined) this.details = options.details;
  }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, allowedKeys, label) {
  if (!isPlainObject(value)) {
    throw new BackupError('INVALID_FORMAT', `${label}はオブジェクトである必要があります`);
  }
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new BackupError('INVALID_RECORD', `${label}に未対応の項目があります`, {
      details: { unknown },
    });
  }
}

function normalizeRecord(record, index) {
  try {
    assertOnlyKeys(record, RECORD_KEYS, `records[${index}]`);
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('INVALID_RECORD', `records[${index}]を検証できません`, { cause: error });
  }

  const result = validateRecord(record, {
    allowId: true,
    allowLegacyPartialExtractTimes: true,
  });
  if (!result.ok) {
    throw new BackupError('INVALID_RECORD', `records[${index}]が不正です`, {
      details: { index, errors: result.errors },
    });
  }
  if (result.value.id === undefined) {
    throw new BackupError('INVALID_RECORD', `records[${index}]にidがありません`, {
      details: { index, field: 'id' },
    });
  }

  const normalized = {};
  for (const key of RECORD_KEYS) {
    normalized[key] = result.value[key] ?? '';
  }
  return normalized;
}

function normalizeRecords(records) {
  const normalized = records.map(normalizeRecord);
  const ids = new Set();
  normalized.forEach((record, index) => {
    if (ids.has(record.id)) {
      throw new BackupError('DUPLICATE_RECORD_ID', `records[${index}]のidが重複しています`, {
        details: { index, id: record.id },
      });
    }
    ids.add(record.id);
  });
  return normalized;
}

function validateIsoDateTime(value, field) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) {
    throw new BackupError('INVALID_FORMAT', `${field}が不正です`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new BackupError('INVALID_FORMAT', `${field}はUTCのISO 8601形式である必要があります`);
  }
  return value;
}

function validateAppVersion(value) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 64) {
    throw new BackupError('INVALID_FORMAT', 'appVersionが不正です');
  }
  return value.trim();
}

function buildPayload({ exportedAt, appVersion, records }) {
  return {
    format: BACKUP_FORMAT,
    formatVersion: BACKUP_FORMAT_VERSION,
    databaseSchemaVersion: BACKUP_DATABASE_SCHEMA_VERSION,
    exportedAt,
    appVersion,
    records,
  };
}

function serializePayload(payload) {
  return JSON.stringify(buildPayload(payload));
}

function buildBackup(payload, digest) {
  return {
    ...payload,
    integrity: {
      algorithm: 'SHA-256',
      canonicalization: BACKUP_CANONICALIZATION,
      digest,
    },
  };
}

async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) {
    throw new BackupError('CRYPTO_UNAVAILABLE', 'SHA-256を利用できない環境です');
  }
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function createBackup(records, {
  appVersion,
  exportedAt = new Date().toISOString(),
  maxRecords = MAX_BACKUP_RECORDS,
} = {}) {
  if (!Array.isArray(records)) {
    throw new BackupError('INVALID_FORMAT', 'recordsは配列である必要があります');
  }
  if (records.length > maxRecords) {
    throw new BackupError('TOO_MANY_RECORDS', `バックアップできる記録は${maxRecords}件までです`);
  }

  const payload = buildPayload({
    exportedAt: validateIsoDateTime(exportedAt, 'exportedAt'),
    appVersion: validateAppVersion(appVersion),
    records: normalizeRecords(records),
  });
  const digest = await sha256Hex(serializePayload(payload));

  return buildBackup(payload, digest);
}

export function serializeBackup(backup) {
  return `${JSON.stringify(backup, null, 2)}\n`;
}

export function estimateSerializedBackupBytes(records, {
  appVersion,
  exportedAt = new Date().toISOString(),
} = {}) {
  if (!Array.isArray(records)) {
    throw new BackupError('INVALID_FORMAT', 'recordsは配列である必要があります');
  }

  // SHA-256 digest is always 64 hex chars, so a placeholder yields the exact size
  // without hashing. No record-count limit here: the UI needs a size for any history.
  const payload = buildPayload({
    exportedAt: validateIsoDateTime(exportedAt, 'exportedAt'),
    appVersion: validateAppVersion(appVersion),
    records: normalizeRecords(records),
  });
  return byteLength(serializeBackup(buildBackup(payload, '0'.repeat(64))));
}

function assertNonNegativeSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
}

function capacityState(current, max, warningAt) {
  if (current > max) return 'over';
  if (current === max) return 'limit';
  if (current >= warningAt) return 'warning';
  return 'normal';
}

export function assessBackupCapacity({ recordCount, backupBytes } = {}, {
  maxRecords = MAX_BACKUP_RECORDS,
  maxBytes = MAX_BACKUP_BYTES,
  warningRatio = BACKUP_WARNING_RATIO,
} = {}) {
  assertNonNegativeSafeInteger(recordCount, 'recordCount');
  assertNonNegativeSafeInteger(backupBytes, 'backupBytes');
  assertPositiveSafeInteger(maxRecords, 'maxRecords');
  assertPositiveSafeInteger(maxBytes, 'maxBytes');
  if (typeof warningRatio !== 'number' || !Number.isFinite(warningRatio)
      || warningRatio <= 0 || warningRatio > 1) {
    throw new TypeError('warningRatio must be greater than 0 and at most 1');
  }

  const recordsWarningAt = Math.ceil(maxRecords * warningRatio);
  const bytesWarningAt = Math.ceil(maxBytes * warningRatio);
  const recordsState = capacityState(recordCount, maxRecords, recordsWarningAt);
  const bytesState = capacityState(backupBytes, maxBytes, bytesWarningAt);
  const stateRank = { normal: 0, warning: 1, limit: 2, over: 3 };
  const level = stateRank[recordsState] >= stateRank[bytesState] ? recordsState : bytesState;

  return {
    level,
    records: {
      current: recordCount,
      max: maxRecords,
      warningAt: recordsWarningAt,
      state: recordsState,
    },
    bytes: {
      current: backupBytes,
      max: maxBytes,
      warningAt: bytesWarningAt,
      state: bytesState,
    },
  };
}

function byteLength(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  throw new BackupError('INVALID_FORMAT', 'バックアップは文字列またはバイト列で指定してください');
}

function decodeBackup(value) {
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder('utf-8', { fatal: true }).decode(value);
  if (ArrayBuffer.isView(value)) {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
    );
  }
  throw new BackupError('INVALID_FORMAT', 'バックアップを読み取れません');
}

export async function parseBackup(input, {
  maxBytes = MAX_BACKUP_BYTES,
  maxRecords = MAX_BACKUP_RECORDS,
} = {}) {
  assertPositiveSafeInteger(maxBytes, 'maxBytes');
  assertNonNegativeSafeInteger(maxRecords, 'maxRecords');
  if (byteLength(input) > maxBytes) {
    throw new BackupError('FILE_TOO_LARGE', `復元できるファイルは${maxBytes}バイトまでです`);
  }

  let raw;
  try {
    raw = JSON.parse(decodeBackup(input));
  } catch (error) {
    if (error instanceof BackupError) throw error;
    throw new BackupError('INVALID_JSON', 'JSONを読み取れません', { cause: error });
  }

  assertOnlyKeys(raw, BACKUP_KEYS, 'backup');
  if (raw.format !== BACKUP_FORMAT) {
    throw new BackupError('INVALID_FORMAT', 'CamSyncバックアップではありません');
  }
  if (raw.formatVersion !== BACKUP_FORMAT_VERSION) {
    throw new BackupError('UNSUPPORTED_VERSION', `formatVersion ${raw.formatVersion}には対応していません`);
  }
  if (raw.databaseSchemaVersion !== BACKUP_DATABASE_SCHEMA_VERSION) {
    throw new BackupError(
      'UNSUPPORTED_DATABASE_VERSION',
      `databaseSchemaVersion ${raw.databaseSchemaVersion}には対応していません`,
    );
  }
  if (!Array.isArray(raw.records)) {
    throw new BackupError('INVALID_FORMAT', 'recordsは配列である必要があります');
  }
  if (raw.records.length > maxRecords) {
    throw new BackupError('TOO_MANY_RECORDS', `復元できる記録は${maxRecords}件までです`);
  }

  assertOnlyKeys(raw.integrity, INTEGRITY_KEYS, 'integrity');
  if (
    raw.integrity.algorithm !== 'SHA-256'
    || raw.integrity.canonicalization !== BACKUP_CANONICALIZATION
    || !/^[0-9a-f]{64}$/.test(raw.integrity.digest)
  ) {
    throw new BackupError('INVALID_INTEGRITY', 'integrity情報が不正です');
  }

  const payload = buildPayload({
    exportedAt: validateIsoDateTime(raw.exportedAt, 'exportedAt'),
    appVersion: validateAppVersion(raw.appVersion),
    records: normalizeRecords(raw.records),
  });
  const actualDigest = await sha256Hex(serializePayload(payload));
  if (actualDigest !== raw.integrity.digest) {
    throw new BackupError('INTEGRITY_MISMATCH', 'バックアップのSHA-256が一致しません');
  }

  return {
    ...payload,
    integrity: { ...raw.integrity },
  };
}

function duplicateKey(record, timestampPrecision) {
  const canonical = canonicalizeRecord(record, {
    allowId: false,
    allowLegacyPartialExtractTimes: true,
  });
  const timestamp = canonical.timestamp;
  if (timestampPrecision === 'minute' && Number.isFinite(timestamp)) {
    canonical.timestamp = Math.floor(timestamp / 60_000) * 60_000;
  } else if (timestampPrecision !== 'exact') {
    throw new TypeError("timestampPrecision must be 'exact' or 'minute'");
  }
  delete canonical.id;
  return JSON.stringify(canonical);
}

export function createDuplicatePlan(incomingRecords, existingRecords, {
  timestampPrecision = 'exact',
} = {}) {
  if (!Array.isArray(incomingRecords) || !Array.isArray(existingRecords)) {
    throw new TypeError('incomingRecords and existingRecords must be arrays');
  }

  const seen = new Map();
  existingRecords.forEach((record, index) => {
    const key = duplicateKey(record, timestampPrecision);
    if (!seen.has(key)) {
      seen.set(key, { kind: 'existing', id: record.id, index });
    }
  });

  const additions = [];
  const duplicates = [];
  incomingRecords.forEach((record, sourceIndex) => {
    const key = duplicateKey(record, timestampPrecision);
    const match = seen.get(key);
    if (match) {
      duplicates.push({
        sourceIndex,
        matchedExistingId: match.kind === 'existing' ? match.id : undefined,
        matchedSourceIndex: match.kind === 'incoming' ? match.sourceIndex : undefined,
      });
      return;
    }
    additions.push(record);
    seen.set(key, { kind: 'incoming', sourceIndex });
  });

  return { additions, duplicates };
}

function withoutId(record) {
  const copy = { ...record };
  delete copy.id;
  return copy;
}

export function createRestorePlan(incomingRecords, existingRecords, { mode = 'merge' } = {}) {
  if (mode === 'replace') {
    return { mode, records: incomingRecords.map((record) => ({ ...record })), duplicates: [] };
  }
  if (mode !== 'merge') throw new TypeError("mode must be 'merge' or 'replace'");

  const duplicatePlan = createDuplicatePlan(incomingRecords, existingRecords);
  return {
    mode,
    records: duplicatePlan.additions.map(withoutId),
    duplicates: duplicatePlan.duplicates,
  };
}
