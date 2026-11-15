import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DRAFT_MAX_AGE_MS,
  DRAFT_STORAGE_KEY,
  clearDraft,
  createDraft,
  loadDraft,
  parseDraft,
  saveDraft,
  serializeDraft
} from '../lib/draft.mjs';

const NOW = Date.UTC(2026, 10, 15, 3, 0, 0);

function sampleInput(overrides = {}) {
  return {
    lockedAt: NOW - 60_000,
    camera: { h: '12', m: '34', s: '56' },
    calculated: true,
    panelVisible: true,
    fields: {
      location: '正面玄関',
      viewDate: '2026-11-15',
      extractDate: '2026-11-14',
      extractStartTime: '10:00',
      extractEndDate: '',
      extractEndTime: '11:00',
      witnessName: '山田 太郎',
      witnessAge: '45',
      notes: '補足'
    },
    ...overrides
  };
}

function memoryStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
    map
  };
}

test('下書きは直列化して同じ内容で復元できる', () => {
  const raw = serializeDraft(createDraft(sampleInput(), { now: NOW }));
  const parsed = parseDraft(raw, { now: NOW });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.lockedAt, NOW - 60_000);
  assert.deepEqual(parsed.value.camera, { h: '12', m: '34', s: '56' });
  assert.equal(parsed.value.calculated, true);
  assert.equal(parsed.value.fields.location, '正面玄関');
  assert.equal(parsed.value.fields.extractEndTime, '11:00');
});

test('下書きには誤差の値を保存しない', () => {
  const raw = serializeDraft(createDraft(sampleInput(), { now: NOW }));
  assert.doesNotMatch(raw, /diffSec|displayVal|direction/);
});

test('壊れたJSONや形式違いは破棄する', () => {
  for (const raw of ['', '{', 'null', '[]', '"x"', '{"format":"other","version":1}']) {
    const parsed = parseDraft(raw, { now: NOW });
    assert.equal(parsed.ok, false, raw);
    assert.ok(parsed.errors[0].code);
  }
});

test('形式バージョンが違う下書きは破棄する', () => {
  const draft = createDraft(sampleInput(), { now: NOW });
  const parsed = parseDraft(JSON.stringify({ ...draft, version: 99 }), { now: NOW });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors[0].code, 'draft_version');
});

test('固定から24時間を超えた下書きは破棄する', () => {
  const old = createDraft(sampleInput({ lockedAt: NOW - DRAFT_MAX_AGE_MS - 1 }), { now: NOW });
  const parsed = parseDraft(serializeDraft(old), { now: NOW });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors[0].code, 'draft_expired');

  const edge = createDraft(sampleInput({ lockedAt: NOW - DRAFT_MAX_AGE_MS }), { now: NOW });
  assert.equal(parseDraft(serializeDraft(edge), { now: NOW }).ok, true);
});

test('未来の固定時刻は破棄する', () => {
  const future = createDraft(sampleInput({ lockedAt: NOW + 10 * 60_000 }), { now: NOW });
  const parsed = parseDraft(serializeDraft(future), { now: NOW });
  assert.equal(parsed.ok, false);
});

test('型・形式・文字数の不正は破棄する', () => {
  const base = createDraft(sampleInput(), { now: NOW });
  const mutations = [
    (d) => { d.lockedAt = '123'; },
    (d) => { d.lockedAt = 1.5; },
    (d) => { d.camera.h = '123'; },
    (d) => { d.camera.m = 'ab'; },
    (d) => { d.calculated = 'yes'; },
    (d) => { d.fields.location = 'あ'.repeat(201); },
    (d) => { d.fields.witnessName = 'あ'.repeat(101); },
    (d) => { d.fields.notes = 'あ'.repeat(4001); },
    (d) => { d.fields.notes = 123; },
    (d) => { d.fields.viewDate = '2026-13-45'; },
    (d) => { d.fields.extractDate = '2026/11/14'; },
    (d) => { d.fields.extractStartTime = '25:00'; },
    (d) => { d.fields.witnessAge = '1234'; },
    (d) => { d.fields = null; },
    (d) => { d.camera = null; }
  ];
  for (const mutate of mutations) {
    const draft = structuredClone(base);
    mutate(draft);
    assert.equal(parseDraft(JSON.stringify(draft), { now: NOW }).ok, false, mutate.toString());
  }
});

test('未知のキーは復元結果に含めない', () => {
  const draft = { ...createDraft(sampleInput(), { now: NOW }), extra: 'x' };
  draft.fields = { ...draft.fields, evil: '<script>' };
  const parsed = parseDraft(JSON.stringify(draft), { now: NOW });
  assert.equal(parsed.ok, true);
  assert.equal('extra' in parsed.value, false);
  assert.equal('evil' in parsed.value.fields, false);
});

test('欠けた欄は空文字として復元する', () => {
  const draft = createDraft(sampleInput(), { now: NOW });
  delete draft.fields.notes;
  const parsed = parseDraft(JSON.stringify(draft), { now: NOW });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.fields.notes, '');
});

test('極端に大きい下書きは読み込まない', () => {
  const parsed = parseDraft(' '.repeat(200_000) + '{}', { now: NOW });
  assert.equal(parsed.ok, false);
  assert.equal(parsed.errors[0].code, 'draft_too_large');
});

test('saveDraft / loadDraft / clearDraft はストレージ経由で往復する', () => {
  const storage = memoryStorage();
  assert.equal(saveDraft(storage, createDraft(sampleInput(), { now: NOW })), true);
  assert.ok(storage.map.has(DRAFT_STORAGE_KEY));
  const loaded = loadDraft(storage, { now: NOW });
  assert.equal(loaded.ok, true);
  clearDraft(storage);
  assert.equal(storage.map.has(DRAFT_STORAGE_KEY), false);
  assert.equal(loadDraft(storage, { now: NOW }).ok, false);
});

test('loadDraft は壊れた下書きと期限切れの下書きをストレージから消す', () => {
  const broken = memoryStorage({ [DRAFT_STORAGE_KEY]: '{oops' });
  assert.equal(loadDraft(broken, { now: NOW }).ok, false);
  assert.equal(broken.map.has(DRAFT_STORAGE_KEY), false);

  const expired = memoryStorage({
    [DRAFT_STORAGE_KEY]: serializeDraft(createDraft(sampleInput({ lockedAt: NOW - DRAFT_MAX_AGE_MS - 1 }), { now: NOW }))
  });
  assert.equal(loadDraft(expired, { now: NOW }).ok, false);
  assert.equal(expired.map.has(DRAFT_STORAGE_KEY), false);
});

test('ストレージが使えなくても例外を投げない', () => {
  const throwing = {
    getItem() { throw new Error('denied'); },
    setItem() { throw new Error('quota'); },
    removeItem() { throw new Error('denied'); }
  };
  assert.equal(saveDraft(throwing, createDraft(sampleInput(), { now: NOW })), false);
  assert.equal(loadDraft(throwing, { now: NOW }).ok, false);
  assert.doesNotThrow(() => clearDraft(throwing));
  assert.equal(saveDraft(null, createDraft(sampleInput(), { now: NOW })), false);
  assert.equal(loadDraft(undefined, { now: NOW }).ok, false);
  assert.doesNotThrow(() => clearDraft(null));
});
