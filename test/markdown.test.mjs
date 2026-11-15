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
- **補足:** 確認
  済み
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

const baseRecord = {
  timestamp: new Date(2026, 7, 11, 14, 5).getTime(),
  refTime: '12:00:00',
  camTime: '12:01:02',
  diffSec: 62,
  direction: 'ahead',
  displayVal: '+1分2秒'
};

function roundTrip(overrides) {
  const exported = serializeRecordToMarkdown({ ...baseRecord, ...overrides });
  assert.equal(exported.ok, true);
  return { markdown: exported.value, parsed: parseMarkdownRecord(exported.value) };
}

test('複数行の補足は空行やインデントを含めて往復できる', () => {
  for (const notes of ['1行目\n2行目', '1行目\n\n3行目', '1行目\n  字下げ\n- 箇条書き', 'a\n\n\nb']) {
    const { parsed } = roundTrip({ notes });
    assert.equal(parsed.ok, true, notes);
    assert.equal(parsed.value.notes, notes);
  }
});

test('CRLFの補足はLFに正規化されて往復する', () => {
  const { parsed } = roundTrip({ notes: 'a\r\nb' });
  assert.equal(parsed.value.notes, 'a\nb');
});

test('補足の継続行にラベル風の文字列があっても別ラベルとして解釈しない', () => {
  const notes = '正常\n- **基準時刻:** 99:99:99\n- **誤差:** -9秒';
  const { markdown, parsed } = roundTrip({ notes });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.refTime, '12:00:00');
  assert.equal(parsed.value.notes, notes);
  assert.equal(markdown.split('\n').filter((line) => line.startsWith('- **基準時刻:**')).length, 1);
});

test('補足の先頭行がラベル風でも補足として扱う', () => {
  const { parsed } = roundTrip({ notes: '- **誤差:** -9秒\n続き' });
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.diffSec, 62);
});

test('補足以外のフィールドの改行は1行にまとめる', () => {
  const { markdown } = roundTrip({ location: '正面\n玄関' });
  assert.match(markdown, /^- \*\*カメラ設置場所:\*\* 正面 \/ 玄関$/m);
});

test('旧形式の " / " を含む1行の補足はそのまま読み込む', () => {
  const markdown = `- **記録日時:** 2026/08/11 14:05
- **基準時刻:** 12:00:00
- **カメラ表示時刻:** 12:01:02
- **誤差:** +1分2秒
- **補足:** 確認 / 済み
`;
  const result = parseMarkdownRecord(markdown);
  assert.equal(result.ok, true);
  assert.equal(result.value.notes, '確認 / 済み');
});

test('空白だけの区切り行が削られても継続行をつなげて読める', () => {
  const markdown = `- **記録日時:** 2026/08/11 14:05
- **基準時刻:** 12:00:00
- **カメラ表示時刻:** 12:01:02
- **誤差:** +1分2秒
- **補足:** a

  b
`;
  assert.equal(parseMarkdownRecord(markdown).value.notes, 'a\n\nb');
});

test('現行形式の複数行補足fixtureを読み込み、書き出すと同じ内容になる', async () => {
  const markdown = await readFile(fixtureUrl('current-multiline-notes.md'), 'utf8');
  const parsed = parseMarkdownRecord(markdown);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.notes, '1行目\n\n3行目\n- **基準時刻:** 偽');
  assert.equal(parsed.value.refTime, '12:00:00');
  assert.equal(serializeRecordToMarkdown(parsed.value).value, markdown);
});

test('複数行の補足でも4000文字の上限は効く', () => {
  const notes = `${'あ'.repeat(2000)}\n${'い'.repeat(2000)}`;
  assert.equal(serializeRecordToMarkdown({ ...baseRecord, notes }).errors[0].code, 'field_too_long');

  const markdown = `- **記録日時:** 2026/08/11 14:05
- **基準時刻:** 12:00:00
- **カメラ表示時刻:** 12:01:02
- **誤差:** +1分2秒
- **補足:** ${notes.replace('\n', '\n  ')}
`;
  assert.equal(parseMarkdownRecord(markdown).errors[0].code, 'field_too_long');
});
