import test from 'node:test';
import assert from 'node:assert/strict';

import { FORM_FIELD_ORDER, groupFormErrors } from '../lib/form-errors.mjs';

const err = (field, message, code = 'x') => ({ code, field, message });

test('入力欄に対応するエラーは欄ごとにまとめ、フォーム順に並べる', () => {
  const grouped = groupFormErrors([
    err('notes', 'n'),
    err('location', 'l'),
    err('witnessAge', 'a')
  ]);
  assert.deepEqual(grouped.fields.map((entry) => entry.field), ['location', 'witnessAge', 'notes']);
  assert.deepEqual(grouped.general, []);
});

test('同じ欄の複数エラーはメッセージを束ねる', () => {
  const grouped = groupFormErrors([err('viewDate', 'a'), err('viewDate', 'b')]);
  assert.deepEqual(grouped.fields, [{ field: 'viewDate', messages: ['a', 'b'] }]);
});

test('抽出期間の個別欄とextractRangeは抽出期間グループへ集約する', () => {
  const grouped = groupFormErrors([
    err('extractRange', '終了が開始より前'),
    err('extractStartTime', '開始時刻が不正'),
    err('extractDate', '開始日が不正')
  ]);
  assert.deepEqual(grouped.fields.map((entry) => entry.field), ['extractDate', 'extractStartTime', 'extractRange']);
  assert.ok(FORM_FIELD_ORDER.indexOf('extractRange') > FORM_FIELD_ORDER.indexOf('extractEndTime'));
});

test('入力欄に対応しないエラーは一般エラーに回す', () => {
  const grouped = groupFormErrors([err('diff', 'd'), err('timestamp', 't'), err(undefined, 'u'), err('record', 'r')]);
  assert.deepEqual(grouped.fields, []);
  assert.deepEqual(grouped.general, ['d', 't', 'u', 'r']);
});

test('errorsが配列でなければ空を返す', () => {
  assert.deepEqual(groupFormErrors(undefined), { fields: [], general: [] });
});
