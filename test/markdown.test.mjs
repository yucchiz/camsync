import { readFile } from 'node:fs/promises';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_MARKDOWN_BYTES,
  parseMarkdownRecord,
  serializeRecordToMarkdown
} from '../lib/markdown.mjs';

const fixtureUrl = (name) => new URL(`./fixtures/${name}`, import.meta.url);

test('parseMarkdownRecord accepts current cross-day output', async () => {
  const markdown = await readFile(fixtureUrl('current-cross-day.md'), 'utf8');
  const result = parseMarkdownRecord(markdown);
  assert.equal(result.ok, true);
  assert.equal(result.value.diffSec, 62);
  assert.equal(result.value.extractEndDate, '2026-08-12');
  assert.equal(result.value.extractEndTime, '00:30');
});

test('parseMarkdownRecord preserves old same-day and one-sided extraction forms', async () => {
  for (const name of ['legacy-same-day.md', 'legacy-start-only.md', 'legacy-end-only.md']) {
    const result = parseMarkdownRecord(await readFile(fixtureUrl(name), 'utf8'));
    assert.equal(result.ok, true, name);
  }
});

test('serializeRecordToMarkdown preserves the nine Japanese labels and ordering', () => {
  const timestamp = new Date(2026, 7, 11, 14, 5).getTime();
  const result = serializeRecordToMarkdown({
    timestamp,
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
    notes: '確認\n済み'
  });
  assert.equal(result.ok, true);
  assert.equal(result.value, `# CamSync 時刻同期記録

- **記録日時:** 2026/08/11 14:05
- **基準時刻:** 12:00:00
- **カメラ表示時刻:** 12:01:02
- **誤差:** +1分2秒
- **カメラ設置場所:** 正面玄関
- **閲覧日:** 2026-08-11
- **抽出日:** 2026-08-11 10:00〜11:00
- **立会人:** 山田 太郎 (45歳)
- **補足:** 確認 / 済み
`);
});

test('Markdown export and import make a semantic round trip', async () => {
  const markdown = await readFile(fixtureUrl('current-cross-day.md'), 'utf8');
  const first = parseMarkdownRecord(markdown);
  assert.equal(first.ok, true);
  const exported = serializeRecordToMarkdown(first.value);
  assert.equal(exported.ok, true);
  const second = parseMarkdownRecord(exported.value);
  assert.deepEqual(second, first);
});

test('parseMarkdownRecord rejects impossible times, dates, and inconsistent drift', async () => {
  const original = await readFile(fixtureUrl('current-cross-day.md'), 'utf8');
  for (const [needle, replacement, code] of [
    ['12:00:00', '99:99:99', 'invalid_time'],
    ['2026/08/11 14:05', '2026/02/31 14:05', 'invalid_record_datetime'],
    ['+1分2秒', '±120秒', 'invalid_diff'],
    ['+1分2秒', '+1分999秒', 'invalid_diff']
  ]) {
    const result = parseMarkdownRecord(original.replace(needle, replacement));
    assert.equal(result.ok, false, replacement);
    assert.equal(result.errors.some((error) => error.code === code), true, replacement);
  }
});

test('parseMarkdownRecord rejects duplicate and missing required labels', async () => {
  const original = await readFile(fixtureUrl('current-cross-day.md'), 'utf8');
  const duplicate = `${original}- **基準時刻:** 12:00:00\n`;
  assert.equal(parseMarkdownRecord(duplicate).errors[0].code, 'duplicate_label');
  assert.equal(parseMarkdownRecord(original.replace(/^- \*\*誤差:.*\n/m, '')).errors[0].code, 'missing_label');
});

test('parseMarkdownRecord enforces the byte limit inside the parser', () => {
  const result = parseMarkdownRecord('a'.repeat(MAX_MARKDOWN_BYTES + 1));
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'markdown_too_large');
});

test('parseMarkdownRecord rejects invalid optional field values', async () => {
  const original = await readFile(fixtureUrl('current-cross-day.md'), 'utf8');
  assert.equal(parseMarkdownRecord(original.replace('2026-08-11', '2026-02-31')).errors.some((error) => error.code === 'invalid_date'), true);
  assert.equal(parseMarkdownRecord(original.replace('(45歳)', '(999歳)')).errors.some((error) => error.code === 'invalid_age'), true);
  assert.equal(parseMarkdownRecord(original.replace('2026-08-12 00:30', '2026-02-31 00:30')).errors.some((error) => error.code === 'invalid_date'), true);
  assert.equal(parseMarkdownRecord(original.replace('2026-08-12 00:30', '')).errors[0].code, 'invalid_extract_format');
});

test('parseMarkdownRecord rejects non-canonical zero and exact diff signs', async () => {
  const original = await readFile(fixtureUrl('current-cross-day.md'), 'utf8');
  for (const replacement of ['+0秒', '-0秒', '+0分0秒', '±1秒', '±5秒', '±1分0秒']) {
    assert.equal(parseMarkdownRecord(original.replace('+1分2秒', replacement)).errors[0].code, 'invalid_diff', replacement);
  }
});
