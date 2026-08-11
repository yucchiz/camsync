import test from 'node:test';
import assert from 'node:assert/strict';

import {
  calculateDrift,
  calculateTimeOffset,
  normalizeExtractRange,
  validateExtractRange
} from '../lib/time.mjs';

test('calculateDrift calculates exact, ahead, and behind values', () => {
  assert.deepEqual(calculateDrift('12:00:00', '12:00:00'), {
    ok: true,
    value: {
      refTime: '12:00:00',
      camTime: '12:00:00',
      diffSec: 0,
      direction: 'exact',
      displayVal: '±0秒'
    }
  });
  assert.equal(calculateDrift('12:00:00', '12:01:02').value.diffSec, 62);
  assert.equal(calculateDrift('12:00:00', '11:59:58').value.diffSec, -2);
});

test('calculateDrift preserves the existing plus or minus 12 hour day-boundary rule', () => {
  assert.equal(calculateDrift('23:59:59', '00:00:01').value.diffSec, 2);
  assert.equal(calculateDrift('00:00:01', '23:59:59').value.diffSec, -2);
  assert.equal(calculateDrift('00:00:00', '12:00:00').value.diffSec, 43200);
  assert.equal(calculateDrift('12:00:00', '00:00:00').value.diffSec, -43200);
});

test('calculateDrift rejects impossible times', () => {
  for (const value of ['24:00:00', '12:60:00', '12:00:60', '99:99:99', '1:00:00']) {
    const result = calculateDrift(value, '12:00:00');
    assert.equal(result.ok, false, value);
    assert.equal(result.errors[0].code, 'invalid_time');
  }
});

test('calculateTimeOffset handles same-day and multi-day changes', () => {
  assert.deepEqual(calculateTimeOffset('10:00:00', '01:02:03', 'add'), {
    ok: true,
    value: { resultTime: '11:02:03', dayOffset: 0, dayLabel: '同日' }
  });
  assert.deepEqual(calculateTimeOffset('23:00:00', '02:00:00', 'add').value, {
    resultTime: '01:00:00', dayOffset: 1, dayLabel: '翌日'
  });
  assert.deepEqual(calculateTimeOffset('01:00:00', '50:00:00', 'sub').value, {
    resultTime: '23:00:00', dayOffset: -3, dayLabel: '3日前'
  });
  assert.equal(calculateTimeOffset('00:00:00', '999:59:59', 'add').ok, true);
});

test('calculateTimeOffset rejects invalid and zero durations', () => {
  assert.equal(calculateTimeOffset('12:00:00', '001:60:00', 'add').errors[0].code, 'invalid_duration');
  assert.equal(calculateTimeOffset('12:00:00', '000:00:00', 'add').errors[0].code, 'zero_duration');
  assert.equal(calculateTimeOffset('12:00:00', '001:00:00', 'multiply').errors[0].code, 'invalid_operator');
});

test('validateExtractRange validates Gregorian dates and chronology', () => {
  assert.equal(validateExtractRange({ startDate: '2024-02-29', startTime: '', endDate: '', endTime: '' }).ok, true);
  assert.equal(validateExtractRange({ startDate: '2026-02-29', startTime: '', endDate: '', endTime: '' }).errors[0].code, 'invalid_date');
  assert.equal(validateExtractRange({ startDate: '2026-08-11', startTime: '23:30', endDate: '2026-08-12', endTime: '00:30' }).ok, true);
  assert.equal(validateExtractRange({ startDate: '2026-08-12', startTime: '', endDate: '2026-08-11', endTime: '' }).errors[0].code, 'extract_end_before_start');
  assert.equal(validateExtractRange({ startDate: '2026-08-11', startTime: '23:30', endDate: '', endTime: '00:30' }).errors[0].code, 'extract_end_before_start');
});

test('validateExtractRange separates strict input from legacy one-sided times', () => {
  const range = { startDate: '2026-08-11', startTime: '10:00', endDate: '', endTime: '' };
  assert.equal(validateExtractRange(range).errors[0].code, 'extract_partial_time');
  assert.equal(validateExtractRange(range, { allowLegacyPartialTimes: true }).ok, true);

  const orphan = { startDate: '', startTime: '10:00', endDate: '', endTime: '' };
  assert.equal(validateExtractRange(orphan, { allowLegacyPartialTimes: true }).errors[0].code, 'extract_start_date_required');
});

test('normalizeExtractRange keeps the historical same-day canonical shape', () => {
  assert.deepEqual(normalizeExtractRange({
    startDate: '2026-08-11',
    startTime: '10:00',
    endDate: '2026-08-11',
    endTime: '11:00'
  }), {
    startDate: '2026-08-11',
    startTime: '10:00',
    endDate: '',
    endTime: '11:00'
  });
});
