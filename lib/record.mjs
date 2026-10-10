import {
  calculateDrift,
  isValidDate,
  normalizeExtractRange,
  validateExtractRange
} from './time.mjs';
import { error, failure, success } from './result.mjs';

export const FIELD_LIMITS = Object.freeze({
  location: 200,
  witnessName: 100,
  notes: 4000
});

// 記録フィールドの唯一の一覧。順序は全件バックアップの SHA-256 ダイジェストに影響するため変更しない。
export const RECORD_KEYS = Object.freeze([
  'id',
  'timestamp',
  'refTime',
  'camTime',
  'diffSec',
  'direction',
  'displayVal',
  'location',
  'viewDate',
  'extractDate',
  'extractStartTime',
  'extractEndDate',
  'extractEndTime',
  'witnessName',
  'witnessAge',
  'notes'
]);

const NON_STRING_FIELDS = new Set(['id', 'timestamp', 'diffSec']);
const STRING_FIELDS = RECORD_KEYS.filter((key) => !NON_STRING_FIELDS.has(key));

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

export function canonicalizeRecord(record, options = {}) {
  const source = record && typeof record === 'object' && !Array.isArray(record) ? record : {};
  const extractRange = normalizeExtractRange({
    startDate: text(source.extractDate),
    startTime: text(source.extractStartTime),
    endDate: text(source.extractEndDate),
    endTime: text(source.extractEndTime)
  });
  const canonical = {
    timestamp: source.timestamp,
    refTime: text(source.refTime),
    camTime: text(source.camTime),
    diffSec: source.diffSec,
    direction: text(source.direction),
    displayVal: text(source.displayVal),
    location: text(source.location),
    viewDate: text(source.viewDate),
    extractDate: extractRange.startDate,
    extractStartTime: extractRange.startTime,
    extractEndDate: extractRange.endDate,
    extractEndTime: extractRange.endTime,
    witnessName: text(source.witnessName),
    witnessAge: text(source.witnessAge),
    notes: text(source.notes)
  };

  if (options.allowId === true && source.id !== undefined) {
    canonical.id = source.id;
  }
  return canonical;
}

export function validateRecord(record, options = {}) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) {
    return failure(error('invalid_record', 'record', '記録データの形式が正しくありません'));
  }

  const errors = [];
  for (const field of STRING_FIELDS) {
    if (record[field] !== undefined && typeof record[field] !== 'string') {
      errors.push(error('invalid_field_type', field, `${field}は文字列である必要があります`));
    }
  }
  if (typeof record.timestamp !== 'number' || !Number.isSafeInteger(record.timestamp) || Number.isNaN(new Date(record.timestamp).getTime())) {
    errors.push(error('invalid_timestamp', 'timestamp', '記録日時が正しくありません'));
  }
  if (typeof record.diffSec !== 'number' || !Number.isInteger(record.diffSec)) {
    errors.push(error('invalid_diff', 'diffSec', '誤差の秒数が正しくありません'));
  }
  if (options.allowId === true && record.id !== undefined && (!Number.isSafeInteger(record.id) || record.id <= 0)) {
    errors.push(error('invalid_id', 'id', '記録IDが正しくありません'));
  }

  const canonical = canonicalizeRecord(record, options);
  const drift = calculateDrift(canonical.refTime, canonical.camTime);
  if (!drift.ok) {
    errors.push(...drift.errors);
  } else if (
    canonical.diffSec !== drift.value.diffSec ||
    canonical.direction !== drift.value.direction ||
    canonical.displayVal !== drift.value.displayVal
  ) {
    errors.push(error('inconsistent_drift', 'diff', '基準時刻・カメラ時刻と誤差が一致しません'));
  }

  if (canonical.viewDate && !isValidDate(canonical.viewDate)) {
    errors.push(error('invalid_date', 'viewDate', '閲覧日が正しい日付ではありません'));
  }

  const extract = validateExtractRange({
    startDate: canonical.extractDate,
    startTime: canonical.extractStartTime,
    endDate: canonical.extractEndDate,
    endTime: canonical.extractEndTime
  }, {
    allowLegacyPartialTimes: options.allowLegacyPartialExtractTimes === true
  });
  if (!extract.ok) errors.push(...extract.errors);

  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    if (canonical[field].length > limit) {
      errors.push(error('field_too_long', field, `${field}は${limit}文字以内で入力してください`));
    }
  }

  if (canonical.witnessAge && (!/^\d{1,3}$/.test(canonical.witnessAge) || Number(canonical.witnessAge) > 120)) {
    errors.push(error('invalid_age', 'witnessAge', '立会人年齢は0から120の整数で入力してください'));
  }

  return errors.length > 0 ? failure(errors) : success(canonical);
}
