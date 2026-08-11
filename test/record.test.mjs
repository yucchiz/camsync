import test from 'node:test';
import assert from 'node:assert/strict';

import { FIELD_LIMITS, canonicalizeRecord, validateRecord } from '../lib/record.mjs';

function validRecord(overrides = {}) {
  return {
    timestamp: new Date(2026, 7, 11, 14, 5).getTime(),
    refTime: '12:00:00',
    camTime: '12:01:02',
    diffSec: 62,
    direction: 'ahead',
    displayVal: '+1分2秒',
    location: '正面玄関',
    viewDate: '2026-08-11',
    extractDate: '2026-08-11',
    extractStartTime: '10:00',
    extractEndDate: '',
    extractEndTime: '11:00',
    witnessName: '山田 太郎',
    witnessAge: '45',
    notes: '確認済み',
    ...overrides
  };
}

test('validateRecord returns a canonical record in a structured result', () => {
  const result = validateRecord(validRecord({ location: '  正面玄関  ', extractEndDate: '2026-08-11' }));
  assert.equal(result.ok, true);
  assert.equal(result.value.location, '正面玄関');
  assert.equal(result.value.extractEndDate, '');
});

test('canonicalizeRecord only projects known fields and optionally preserves an id', () => {
  const source = validRecord({ id: 12, unknown: 'discard me' });
  assert.equal(canonicalizeRecord(source).id, undefined);
  const canonical = canonicalizeRecord(source, { allowId: true });
  assert.equal(canonical.id, 12);
  assert.equal(canonical.unknown, undefined);
});

test('validateRecord checks derived drift fields instead of trusting imported values', () => {
  for (const overrides of [
    { diffSec: 120 },
    { direction: 'exact' },
    { displayVal: '±120秒' }
  ]) {
    const result = validateRecord(validRecord(overrides));
    assert.equal(result.ok, false);
    assert.equal(result.errors.some((error) => error.code === 'inconsistent_drift'), true);
  }
});

test('validateRecord rejects invalid dates, ages, and overlong text', () => {
  assert.equal(validateRecord(validRecord({ viewDate: '2026-02-31' })).errors[0].code, 'invalid_date');
  assert.equal(validateRecord(validRecord({ witnessAge: '999' })).errors[0].code, 'invalid_age');
  assert.equal(validateRecord(validRecord({ witnessAge: '12.5' })).errors[0].code, 'invalid_age');
  assert.equal(validateRecord(validRecord({ location: 'a'.repeat(FIELD_LIMITS.location + 1) })).errors[0].code, 'field_too_long');
  assert.equal(validateRecord(validRecord({ location: 'a'.repeat(FIELD_LIMITS.location) })).ok, true);
  assert.equal(validateRecord(validRecord({ witnessName: 'a'.repeat(FIELD_LIMITS.witnessName + 1) })).errors[0].code, 'field_too_long');
  assert.equal(validateRecord(validRecord({ notes: 'a'.repeat(FIELD_LIMITS.notes + 1) })).errors[0].code, 'field_too_long');
  assert.equal(validateRecord(validRecord({ notes: null })).errors[0].code, 'invalid_field_type');
});

test('validateRecord supports strict saves and legacy Markdown extraction shapes', () => {
  const partial = validRecord({ extractEndTime: '' });
  assert.equal(validateRecord(partial).errors[0].code, 'extract_partial_time');
  assert.equal(validateRecord(partial, { allowLegacyPartialExtractTimes: true }).ok, true);
});

test('validateRecord preserves a valid IndexedDB id only when requested', () => {
  const result = validateRecord(validRecord({ id: 7 }), { allowId: true });
  assert.equal(result.ok, true);
  assert.equal(result.value.id, 7);
  assert.equal(validateRecord(validRecord({ id: -1 }), { allowId: true }).errors[0].code, 'invalid_id');
});
