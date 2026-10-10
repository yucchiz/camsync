import { formatRecordDateTime, isValidDate } from './time.mjs';
import { error, failure, success } from './result.mjs';
import { validateRecord } from './record.mjs';

export const MAX_MARKDOWN_BYTES = 1024 * 1024;

const LABELS = Object.freeze([
  '記録日時',
  '基準時刻',
  'カメラ表示時刻',
  '誤差',
  'カメラ設置場所',
  '閲覧日',
  '抽出日',
  '立会人',
  '補足'
]);

const REQUIRED_LABELS = Object.freeze([
  '記録日時',
  '基準時刻',
  'カメラ表示時刻',
  '誤差'
]);

const LABEL_SET = new Set(LABELS);

function byteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function normalizeMarkdownValue(value) {
  return String(value ?? '').replace(/\r?\n/g, ' / ').trim();
}

function extractKnownLabels(markdown) {
  const values = new Map();
  const errors = [];
  const linePattern = /^- \*\*(.+?):\*\*\s*(.*)$/;

  for (const line of markdown.split(/\r?\n/)) {
    const match = linePattern.exec(line);
    if (!match || !LABEL_SET.has(match[1])) continue;
    const label = match[1];
    if (values.has(label)) {
      errors.push(error('duplicate_label', label, `${label}が複数回記載されています`));
      continue;
    }
    values.set(label, match[2].trim());
  }

  for (const label of REQUIRED_LABELS) {
    if (!values.get(label)) {
      errors.push(error('missing_label', label, `${label}が記載されていません`));
    }
  }
  return errors.length > 0 ? failure(errors) : success(values);
}

function parseRecordTimestamp(value) {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  const dateValue = `${match[1]}-${match[2]}-${match[3]}`;
  const hours = Number(match[4]);
  const minutes = Number(match[5]);
  if (!isValidDate(dateValue) || hours > 23 || minutes > 59) return null;

  const date = new Date(0);
  date.setFullYear(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  date.setHours(hours, minutes, 0, 0);
  if (
    date.getFullYear() !== Number(match[1]) ||
    date.getMonth() !== Number(match[2]) - 1 ||
    date.getDate() !== Number(match[3]) ||
    date.getHours() !== hours ||
    date.getMinutes() !== minutes
  ) return null;
  return date.getTime();
}

function parseDiff(value) {
  const match = /^([+\-±])(?:(\d+)分)?(\d+)秒$/.exec(value);
  if (!match) return null;
  const minutes = match[2] ? Number(match[2]) : 0;
  const seconds = Number(match[3]);
  if (!Number.isSafeInteger(minutes) || !Number.isSafeInteger(seconds) || seconds > 59) return null;
  const absoluteSeconds = minutes * 60 + seconds;
  const sign = match[1];
  if ((sign === '±') !== (absoluteSeconds === 0)) return null;

  return {
    diffSec: sign === '-' ? -absoluteSeconds : absoluteSeconds,
    direction: sign === '-' ? 'behind' : sign === '+' ? 'ahead' : 'exact'
  };
}

function parseExtractRange(value) {
  if (!value) {
    return success({ extractDate: '', extractStartTime: '', extractEndDate: '', extractEndTime: '' });
  }

  // Historical exports permit either side of the time range to be omitted.
  const match = /^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}:\d{2}))?(?:〜(\d{4}-\d{2}-\d{2})?\s*(\d{2}:\d{2})?)?$/.exec(value);
  if (!match || (value.includes('〜') && !match[3] && !match[4])) {
    return failure(error('invalid_extract_format', 'extractRange', '抽出日の形式が正しくありません'));
  }
  return success({
    extractDate: match[1] || '',
    extractStartTime: match[2] || '',
    extractEndDate: match[3] === match[1] ? '' : match[3] || '',
    extractEndTime: match[4] || ''
  });
}

function parseWitness(value) {
  if (!value) return success({ witnessName: '', witnessAge: '' });
  const match = /^(.+?)(?:\s*\((\d+)歳\))?$/.exec(value);
  if (!match) {
    return failure(error('invalid_witness', 'witnessName', '立会人の形式が正しくありません'));
  }
  return success({ witnessName: match[1].trim(), witnessAge: match[2] || '' });
}

export function parseMarkdownRecord(markdown) {
  if (typeof markdown !== 'string') {
    return failure(error('invalid_markdown', 'markdown', 'Markdownは文字列である必要があります'));
  }
  if (byteLength(markdown) > MAX_MARKDOWN_BYTES) {
    return failure(error('markdown_too_large', 'markdown', 'Markdownは1 MiB以内である必要があります'));
  }

  const labels = extractKnownLabels(markdown);
  if (!labels.ok) return labels;
  const values = labels.value;
  const timestamp = parseRecordTimestamp(values.get('記録日時'));
  if (timestamp === null) {
    return failure(error('invalid_record_datetime', 'timestamp', '記録日時が正しくありません'));
  }
  const diff = parseDiff(values.get('誤差'));
  if (!diff) {
    return failure(error('invalid_diff', 'displayVal', '誤差の形式が正しくありません'));
  }
  const extractRange = parseExtractRange(values.get('抽出日') || '');
  if (!extractRange.ok) return extractRange;
  const witness = parseWitness(values.get('立会人') || '');
  if (!witness.ok) return witness;

  return validateRecord({
    timestamp,
    refTime: values.get('基準時刻'),
    camTime: values.get('カメラ表示時刻'),
    diffSec: diff.diffSec,
    direction: diff.direction,
    displayVal: values.get('誤差'),
    location: values.get('カメラ設置場所') || '',
    viewDate: values.get('閲覧日') || '',
    ...extractRange.value,
    ...witness.value,
    notes: values.get('補足') || ''
  }, {
    allowLegacyPartialExtractTimes: true
  });
}

export function serializeRecordToMarkdown(record) {
  const validated = validateRecord(record, {
    allowLegacyPartialExtractTimes: true
  });
  if (!validated.ok) return validated;
  const value = validated.value;
  let markdown = '# CamSync 時刻同期記録\n\n';
  markdown += `- **記録日時:** ${formatRecordDateTime(value.timestamp)}\n`;
  markdown += `- **基準時刻:** ${normalizeMarkdownValue(value.refTime)}\n`;
  markdown += `- **カメラ表示時刻:** ${normalizeMarkdownValue(value.camTime)}\n`;
  markdown += `- **誤差:** ${normalizeMarkdownValue(value.displayVal)}\n`;
  if (value.location) markdown += `- **カメラ設置場所:** ${normalizeMarkdownValue(value.location)}\n`;
  if (value.viewDate) markdown += `- **閲覧日:** ${normalizeMarkdownValue(value.viewDate)}\n`;
  if (value.extractDate) {
    let extract = `- **抽出日:** ${normalizeMarkdownValue(value.extractDate)}`;
    if (value.extractStartTime) extract += ` ${normalizeMarkdownValue(value.extractStartTime)}`;
    if (value.extractEndDate && value.extractEndDate !== value.extractDate) {
      extract += `〜${normalizeMarkdownValue(value.extractEndDate)}`;
      if (value.extractEndTime) extract += ` ${normalizeMarkdownValue(value.extractEndTime)}`;
    } else if (value.extractEndTime) {
      extract += `〜${normalizeMarkdownValue(value.extractEndTime)}`;
    }
    markdown += `${extract}\n`;
  }
  if (value.witnessName) {
    let witness = `- **立会人:** ${normalizeMarkdownValue(value.witnessName)}`;
    if (value.witnessAge) witness += ` (${normalizeMarkdownValue(value.witnessAge)}歳)`;
    markdown += `${witness}\n`;
  }
  if (value.notes) markdown += `- **補足:** ${normalizeMarkdownValue(value.notes)}\n`;

  if (byteLength(markdown) > MAX_MARKDOWN_BYTES) {
    return failure(error('markdown_too_large', 'markdown', 'Markdownは1 MiB以内である必要があります'));
  }
  return success(markdown);
}
