import { FIELD_LIMITS } from './record.mjs';
import { error, failure, success } from './result.mjs';
import { isValidDate } from './time.mjs';
import { readItem, removeItem, writeItem } from './safe-storage.mjs';

export const DRAFT_STORAGE_KEY = 'camsync.draft.v1';
export const DRAFT_FORMAT = 'camsync-draft';
export const DRAFT_VERSION = 1;
export const DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const DRAFT_MAX_BYTES = 64 * 1024;
const FUTURE_TOLERANCE_MS = 5 * 60 * 1000;

const CAMERA_KEYS = ['h', 'm', 's'];
const FIELD_KEYS = [
  'location',
  'viewDate',
  'extractDate',
  'extractStartTime',
  'extractEndDate',
  'extractEndTime',
  'witnessName',
  'witnessAge',
  'notes'
];
const DATE_FIELDS = ['viewDate', 'extractDate', 'extractEndDate'];
const TIME_FIELDS = ['extractStartTime', 'extractEndTime'];

function invalid(code, message) {
  return failure(error(code, 'draft', message));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// 下書きの形を作る。誤差の値は保存せず、復元時に基準時刻とカメラ時刻から再計算する。
export function createDraft({ lockedAt, camera = {}, calculated = false, panelVisible = false, fields = {} }, { now = Date.now() } = {}) {
  return {
    format: DRAFT_FORMAT,
    version: DRAFT_VERSION,
    savedAt: now,
    lockedAt,
    camera: Object.fromEntries(CAMERA_KEYS.map((key) => [key, String(camera[key] ?? '')])),
    calculated: calculated === true,
    panelVisible: panelVisible === true,
    fields: Object.fromEntries(FIELD_KEYS.map((key) => [key, String(fields[key] ?? '')]))
  };
}

export function serializeDraft(draft) {
  return JSON.stringify(draft);
}

function parseCamera(camera) {
  if (!isPlainObject(camera)) return null;
  const result = {};
  for (const key of CAMERA_KEYS) {
    const value = camera[key] ?? '';
    if (typeof value !== 'string' || !/^\d{0,2}$/.test(value)) return null;
    result[key] = value;
  }
  return result;
}

function parseFields(fields) {
  if (!isPlainObject(fields)) return null;
  const result = {};
  for (const key of FIELD_KEYS) {
    const value = fields[key] ?? '';
    if (typeof value !== 'string') return null;
    if (key in FIELD_LIMITS && value.length > FIELD_LIMITS[key]) return null;
    if (DATE_FIELDS.includes(key) && value && !isValidDate(value)) return null;
    if (TIME_FIELDS.includes(key) && value && !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) return null;
    if (key === 'witnessAge' && !/^\d{0,3}$/.test(value)) return null;
    result[key] = value;
  }
  return result;
}

// 下書きは信頼しない入力として扱い、形式・型・上限・期限を検証して新しいオブジェクトに詰め直す。
export function parseDraft(raw, { now = Date.now() } = {}) {
  if (typeof raw !== 'string' || raw === '') return invalid('draft_empty', '下書きがありません');
  if (raw.length > DRAFT_MAX_BYTES) return invalid('draft_too_large', '下書きが大きすぎます');

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return invalid('draft_malformed', '下書きを読み取れません');
  }
  if (!isPlainObject(data) || data.format !== DRAFT_FORMAT) {
    return invalid('draft_format', '下書きの形式が正しくありません');
  }
  if (data.version !== DRAFT_VERSION) return invalid('draft_version', '下書きの形式バージョンが対応外です');
  if (!Number.isSafeInteger(data.lockedAt) || data.lockedAt <= 0) {
    return invalid('draft_locked_at', '固定した時刻が正しくありません');
  }
  if (data.lockedAt > now + FUTURE_TOLERANCE_MS) return invalid('draft_future', '固定した時刻が未来です');
  if (now - data.lockedAt > DRAFT_MAX_AGE_MS) return invalid('draft_expired', '下書きが古すぎます');
  if (typeof data.calculated !== 'boolean') return invalid('draft_calculated', '計算済みの状態が正しくありません');
  if (data.panelVisible !== undefined && typeof data.panelVisible !== 'boolean') {
    return invalid('draft_panel', '結果パネルの状態が正しくありません');
  }

  const camera = parseCamera(data.camera);
  if (!camera) return invalid('draft_camera', 'カメラ時刻の入力が正しくありません');
  const fields = parseFields(data.fields);
  if (!fields) return invalid('draft_fields', '記録情報の入力が正しくありません');

  return success({
    lockedAt: data.lockedAt,
    camera,
    calculated: data.calculated,
    panelVisible: data.panelVisible === true || data.calculated,
    fields
  });
}

export function saveDraft(storage, draft) {
  return writeItem(storage, DRAFT_STORAGE_KEY, serializeDraft(draft));
}

export function clearDraft(storage) {
  removeItem(storage, DRAFT_STORAGE_KEY);
}

// 読み込めない下書き（壊れている・古い）はストレージからも消す。
export function loadDraft(storage, { now = Date.now() } = {}) {
  const raw = readItem(storage, DRAFT_STORAGE_KEY);
  if (raw === null) return invalid('draft_empty', '下書きがありません');
  const parsed = parseDraft(raw, { now });
  if (!parsed.ok) clearDraft(storage);
  return parsed;
}
