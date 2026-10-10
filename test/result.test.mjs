import test from 'node:test';
import assert from 'node:assert/strict';

import { error, failure, success } from '../lib/result.mjs';

test('error builds a code, field, and message object', () => {
  assert.deepEqual(error('invalid_time', 'refTime', '時刻が正しくありません'), {
    code: 'invalid_time',
    field: 'refTime',
    message: '時刻が正しくありません'
  });
});

test('success wraps a value', () => {
  assert.deepEqual(success({ a: 1 }), { ok: true, value: { a: 1 } });
});

test('failure wraps a single error in an array', () => {
  const single = error('x', 'f', 'm');
  assert.deepEqual(failure(single), { ok: false, errors: [single] });
});

test('failure keeps an error array as is', () => {
  const errors = [error('x', 'f', 'm'), error('y', 'g', 'n')];
  const result = failure(errors);
  assert.equal(result.ok, false);
  assert.equal(result.errors, errors);
});
