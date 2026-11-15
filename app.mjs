import {
  calculateDrift,
  calculateTimeOffset,
  formatCompactDateTime,
  formatRecordDateTime as formatRecordDateTimeOrNull,
  normalizeExtractRange,
  pad2,
  validateExtractRange,
} from './lib/time.mjs';
import { validateRecord } from './lib/record.mjs';
import {
  MAX_MARKDOWN_BYTES,
  parseMarkdownRecord,
  serializeRecordToMarkdown,
} from './lib/markdown.mjs';
import {
  addAttachment,
  addRecord,
  bulkAddRecords,
  clearAllRecords,
  createDeferredRecordDeleter,
  deleteAttachment,
  getAllRecords,
  getAttachment,
  getRecord,
  listAllAttachments,
  listAttachments,
  replaceAllRecords,
  updateRecord,
} from './lib/storage.mjs';
import {
  ATTACHMENT_LIMITS,
  normalizeAttachmentFileName,
  prepareAttachment,
} from './lib/attachment.mjs';
import {
  MAX_BACKUP_BYTES,
  assessBackupCapacity,
  createBackup,
  createDuplicatePlan,
  createRestorePlan,
  estimateSerializedBackupBytes,
  parseBackup,
  serializeBackup,
} from './lib/backup.mjs';
import {
  createKeyboardViewportTracker,
  resolveVisibleAppHeight,
} from './lib/viewport.mjs';
import {
  clearDraft,
  createDraft,
  loadDraft,
  saveDraft,
} from './lib/draft.mjs';
import {
  createBackupMeta,
  describeBackupStatus,
  loadBackupMeta,
  saveBackupMeta,
} from './lib/backup-status.mjs';
import { groupFormErrors } from './lib/form-errors.mjs';
import { describePersistence, formatStorageUsage } from './lib/storage-info.mjs';

const APP_VERSION = '2.9.0';
const DIRECTION_LABELS = {
  ahead: 'カメラ時刻が進んでいます',
  behind: 'カメラ時刻が遅れています',
  exact: '時刻は正確です',
};
const HISTORY_COUNT_FORMATTER = new Intl.NumberFormat('ja-JP');
const BACKUP_MIB_FORMATTER = new Intl.NumberFormat('ja-JP', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const CAPACITY_STATE_MESSAGES = {
  warning: '上限に近づいています',
  limit: '上限に達しています',
  over: '上限を超えています',
};
const CAPACITY_LEVEL_LABELS = {
  warning: '注意',
  limit: '上限',
  over: '上限超過',
};
const CAPACITY_LEVEL_ACTIONS = {
  warning: '早めに全件バックアップし、不要な履歴を整理してください。',
  limit: 'これ以上増える前に全件バックアップし、不要な履歴を整理してください。',
  over: '全件バックアップまたは復元ができない可能性があります。重要な記録を個別にMD出力してから、不要な履歴を整理してください。',
};
// 記録フォームのフィールド名と入力要素IDの対応表（作成フォーム・編集フォーム）。
const FORM_FIELD_IDS = Object.freeze({
  create: Object.freeze({
    location: 'camLocation',
    viewDate: 'viewDate',
    extractDate: 'extractDate',
    extractStartTime: 'extractStartTime',
    extractEndDate: 'extractEndDate',
    extractEndTime: 'extractEndTime',
    witnessName: 'witnessName',
    witnessAge: 'witnessAge',
    notes: 'notes',
  }),
  edit: Object.freeze({
    location: 'editLocation',
    viewDate: 'editViewDate',
    extractDate: 'editExtractDate',
    extractStartTime: 'editExtractStartTime',
    extractEndDate: 'editExtractEndDate',
    extractEndTime: 'editExtractEndTime',
    witnessName: 'editWitnessName',
    witnessAge: 'editWitnessAge',
    notes: 'editNotes',
  }),
});
const el = (id) => document.getElementById(id);
const UNDO_TOAST_MS = 6000;
const TOAST_MS = 3200;
const EXTRACT_FIELDS = ['extractDate', 'extractStartTime', 'extractEndDate', 'extractEndTime'];
const STALE_RESULT_MESSAGE = '再計算が必要です';
const ATTACHMENT_TYPE_LABELS = Object.freeze({
  'image/jpeg': 'JPEG画像',
  'image/png': 'PNG画像',
  'image/webp': 'WebP画像',
  'image/heic': 'HEIC画像',
  'image/heif': 'HEIF画像',
  'application/pdf': 'PDF',
});
// 添付の保存（ダウンロード）は大きなファイルもあるため、URLの解放を少し長めに待つ。
const ATTACHMENT_DOWNLOAD_URL_TTL_MS = 30000;
// 利用者が対処できる理由を含むストレージエラー。これ以外は操作ごとの汎用メッセージにする。
const USER_FACING_STORAGE_ERRORS = new Set([
  'QUOTA_EXCEEDED',
  'BLOCKED',
  'VERSION_MISMATCH',
  'UNAVAILABLE',
  'ATTACHMENT_LIMIT_REACHED',
  'ATTACHMENT_MISSING',
]);

// 下書き・バックアップ情報は端末内の localStorage にだけ保存する。使えない環境では null。
const localStore = (() => {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
})();

let lockedRefDate = null;
let lastCalcResult = null;
let timeCalcOperator = 'add';
let editingRecordId = null;
let editingBaseResult = null;
let pendingDuplicateRecord = null;
let pendingRestoreRecords = null;
let dialogReturnFocus = null;
let waitingWorker = null;
let isDirty = false;
let toastTimer = null;
let viewportSyncFrame = null;
let keyboardScrollTop = null;
let keyboardWasActive = false;
let editSnapshot = null;
// 保存ボタンの連打で同じ記録を二重に保存しないための処理中フラグ。
let isSavingRecord = false;
let lastHistoryCount = 0;
let attachmentRenderGeneration = 0;
let attachmentUploadInProgress = false;
let previewUrl = null;
let previewName = '';
let previewToken = 0;
// 共有シートはユーザー操作の直後にしか開けないため、読み込み後に失敗したファイルを次のタップ用に持つ。
let preparedShare = null;
let fileShareSupported = null;

// 個別削除は取り消し猶予の間は実際には削除せず、猶予が過ぎてから記録と添付をまとめて確定削除する。
// アプリが背面に回るときは猶予を待たずに確定する。確定前に強制終了された場合、記録と添付は残る。
const recordDeleter = createDeferredRecordDeleter({
  delayMs: UNDO_TOAST_MS + 500,
  onCommitError: (id, error) => {
    console.error('記録の削除を確定できませんでした', id, error);
    showToast(storageErrorMessage(error, '記録の削除に失敗しました。記録は残っています'), true);
    renderHistory();
  },
});

const viewportTracker = createKeyboardViewportTracker(
  window.visualViewport?.height ?? window.innerHeight,
);

function formatHms(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDateInput(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatRecordDateTime(timestamp) {
  return formatRecordDateTimeOrNull(timestamp) ?? '日時不明';
}

function hideToast() {
  clearTimeout(toastTimer);
  const toast = el('toast');
  toast.classList.remove('show', 'has-action');
  toast.replaceChildren();
}

// action を渡すと、メッセージの横に操作ボタン（例：元に戻す）を表示する。
function showToast(message, isError = false, { action = null, duration = TOAST_MS, focusAction = false } = {}) {
  const toast = el('toast');
  clearTimeout(toastTimer);
  // 取り消し猶予中の削除があるのに別のトーストで「元に戻す」が消えると、戻す手段がなくなる。
  // 猶予中は後続のトーストにも取り消しボタンを付ける。
  if (!action && recordDeleter.hasCancellable()) {
    action = { label: '削除を元に戻す', onClick: undoRemoveRecord };
    duration = Math.max(duration, UNDO_TOAST_MS);
  }
  const text = document.createElement('span');
  text.textContent = message;
  toast.replaceChildren(text);
  let actionButton = null;
  if (action) {
    actionButton = makeButton(action.label, 'toast-action', async () => {
      hideToast();
      await action.onClick();
    });
    toast.append(actionButton);
  }
  toast.classList.toggle('error', isError);
  toast.classList.toggle('has-action', Boolean(action));
  toast.setAttribute('role', isError ? 'alert' : 'status');
  toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  toast.classList.add('show');
  toastTimer = setTimeout(hideToast, duration);
  // 操作元の要素が再描画で消えるため、スクリーンリーダー・キーボード利用者が届くようボタンへ移す。
  if (focusAction) actionButton?.focus({ preventScroll: true });
}

function firstErrorMessage(result, fallback) {
  return result?.errors?.[0]?.message || fallback;
}

function formatCaughtError(error, fallback) {
  const nested = error?.details?.errors?.[0]?.message;
  const message = typeof error?.message === 'string' ? error.message : '';
  if (message && nested && !message.includes(nested)) {
    return `${message}（${nested}）`;
  }
  return message || fallback;
}

function storageErrorMessage(error, fallback) {
  return USER_FACING_STORAGE_ERRORS.has(error?.code) && error.message ? error.message : fallback;
}

function setDirty(value = true) {
  isDirty = value;
}

function updateClock() {
  const now = new Date();
  if (!lockedRefDate) el('liveClock').textContent = formatHms(now);
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  el('liveDate').textContent = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} (${weekdays[now.getDay()]})`;
}

function showLockedUi() {
  const value = formatHms(lockedRefDate);
  el('liveClock').textContent = value;
  el('liveClock').classList.add('locked');
  el('lockBtn').textContent = '固定済み';
  el('lockBtn').classList.add('locked');
  el('lockBtn').setAttribute('aria-pressed', 'true');
  el('lockedTime').textContent = value;
  el('lockedDisplay').hidden = false;
}

function lockClock() {
  if (lockedRefDate) return;
  lockedRefDate = new Date();
  showLockedUi();
  el('viewDate').value = formatDateInput(lockedRefDate);
  hideDraftNotice();
  setDirty();
  persistDraft();
}

// 入力済みの記録情報は残したまま、基準時刻だけ現在時刻で固定し直す。誤差の計算結果は無効になる。
function relockClock() {
  if (!lockedRefDate) return;
  lockedRefDate = new Date();
  showLockedUi();
  invalidateCalculation();
  hideDraftNotice();
  setDirty();
  persistDraft();
  showToast('基準時刻を固定し直しました。誤差を計算し直してください');
}

function resetLock({ preserveDirty = false } = {}) {
  lockedRefDate = null;
  lastCalcResult = null;
  el('liveClock').classList.remove('locked');
  el('lockBtn').textContent = 'タップで固定';
  el('lockBtn').classList.remove('locked');
  el('lockBtn').setAttribute('aria-pressed', 'false');
  el('lockedDisplay').hidden = true;
  el('resultPanel').hidden = true;
  el('resultPanel').classList.remove('stale');
  if (!preserveDirty) setDirty(false);
}

const CAMERA_TIME_INPUT_IDS = ['camH', 'camM', 'camS'];
const TIME_CALC_BASE_INPUT_IDS = ['timeCalcH', 'timeCalcM', 'timeCalcS'];
const TIME_CALC_DURATION_INPUT_IDS = ['timeCalcDiffH', 'timeCalcDiffM', 'timeCalcDiffS'];

function hasEmptyInput(ids) {
  return ids.some((id) => el(id).value === '');
}

// 時間差の「時」は3桁まで入るため、桁を切らずに2桁未満だけ0埋めする。
function readClockInputs(ids, { emptyAsZero = false } = {}) {
  return ids
    .map((id) => {
      const value = el(id).value;
      return (emptyAsZero && value === '' ? '0' : value).padStart(2, '0');
    })
    .join(':');
}

function showCalcResult(value) {
  lastCalcResult = value;
  const direction = value.direction;
  el('resultPanel').classList.remove('stale');
  el('resultDir').textContent = DIRECTION_LABELS[direction];
  el('resultDir').className = `result-direction ${direction}`;
  el('resultVal').textContent = value.displayVal;
  el('resultVal').className = `result-value ${direction}`;
  const sign = value.diffSec > 0 ? '+' : value.diffSec < 0 ? '-' : '±';
  el('resultUnit').textContent = `（${sign}${Math.abs(value.diffSec)}秒）`;
  el('resultDetail').textContent = `基準: ${value.refTime}\nカメラ: ${value.camTime}`;
  el('resultPanel').hidden = false;
}

// 誤差表示だけを「再計算が必要」にする。記録情報の入力内容には触れない。
function showStaleResult() {
  el('resultPanel').classList.add('stale');
  el('resultDir').textContent = STALE_RESULT_MESSAGE;
  el('resultDir').className = 'result-direction';
  el('resultVal').textContent = '--';
  el('resultVal').className = 'result-value';
  el('resultUnit').textContent = '';
  el('resultDetail').textContent = '基準時刻またはカメラ時刻が変わりました。「誤差を計算」を押してください。';
}

function invalidateCalculation() {
  if (!lastCalcResult) return;
  lastCalcResult = null;
  showStaleResult();
}

function calculateCameraDrift() {
  if (!lockedRefDate) {
    showToast('先に基準時刻を固定してください', true);
    return;
  }
  if (hasEmptyInput(CAMERA_TIME_INPUT_IDS)) {
    showToast('カメラ時刻を入力してください', true);
    return;
  }
  const result = calculateDrift(formatHms(lockedRefDate), readClockInputs(CAMERA_TIME_INPUT_IDS));
  if (!result.ok) {
    showToast(firstErrorMessage(result, 'カメラ時刻を24時間表記で入力してください'), true);
    return;
  }
  showCalcResult(result.value);
  setDirty();
  persistDraft();
}

function recordFromForm(mode = 'create') {
  const ids = FORM_FIELD_IDS[mode];
  const range = normalizeExtractRange({
    startDate: el(ids.extractDate).value,
    startTime: el(ids.extractStartTime).value,
    endDate: el(ids.extractEndDate).value,
    endTime: el(ids.extractEndTime).value,
  });
  const calculation = mode === 'edit' ? editingBaseResult : lastCalcResult;
  return {
    // 新規記録の日時は保存ボタンを押した時刻ではなく、基準時刻を固定した瞬間にする。
    timestamp: mode === 'create' && lockedRefDate ? lockedRefDate.getTime() : Date.now(),
    ...calculation,
    location: el(ids.location).value.trim(),
    viewDate: el(ids.viewDate).value,
    extractDate: range.startDate,
    extractStartTime: range.startTime,
    extractEndDate: range.endDate,
    extractEndTime: range.endTime,
    witnessName: el(ids.witnessName).value.trim(),
    witnessAge: el(ids.witnessAge).value,
    notes: el(ids.notes).value.trim(),
  };
}

function errorElementId(mode, group) {
  return `${mode}-error-${group}`;
}

function errorGroupOf(field) {
  return EXTRACT_FIELDS.includes(field) ? 'extract' : field;
}

function clearFieldErrors(mode) {
  for (const id of Object.values(FORM_FIELD_IDS[mode])) {
    el(id).removeAttribute('aria-invalid');
    el(id).removeAttribute('aria-describedby');
  }
  document.querySelectorAll(`[data-form-mode="${mode}"]`).forEach((node) => node.remove());
}

function clearFieldError(mode, field) {
  const group = errorGroupOf(field);
  document.getElementById(errorElementId(mode, group))?.remove();
  const ids = FORM_FIELD_IDS[mode];
  const fields = group === 'extract' ? EXTRACT_FIELDS : [field];
  for (const name of fields) {
    el(ids[name]).removeAttribute('aria-invalid');
    el(ids[name]).removeAttribute('aria-describedby');
  }
}

function appendFieldError(mode, group, host, messages) {
  const node = document.createElement('p');
  node.id = errorElementId(mode, group);
  node.className = 'field-error';
  node.dataset.formMode = mode;
  node.textContent = messages.join('\n');
  host.append(node);
  return node.id;
}

function markInvalid(input, describedBy) {
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', describedBy);
}

// 検証エラーを該当欄の近くに表示し、最初のエラー欄へフォーカスを移す。
function reportFormErrors(mode, errors) {
  clearFieldErrors(mode);
  const ids = FORM_FIELD_IDS[mode];
  const { fields, general } = groupFormErrors(errors);
  const extractMessages = [];
  const extractInvalid = new Set();
  let firstInput = null;

  for (const { field, messages } of fields) {
    const isExtract = field === 'extractRange' || EXTRACT_FIELDS.includes(field);
    const input = el(field === 'extractRange' ? ids.extractDate : ids[field]);
    firstInput ??= input;
    if (isExtract) {
      extractMessages.push(...messages);
      if (field === 'extractRange') EXTRACT_FIELDS.forEach((name) => extractInvalid.add(name));
      else extractInvalid.add(field);
      continue;
    }
    const errorId = appendFieldError(mode, field, input.closest('.field'), messages);
    markInvalid(input, errorId);
  }
  if (extractMessages.length > 0) {
    const fieldset = el(ids.extractDate).closest('fieldset');
    const errorId = appendFieldError(mode, 'extract', fieldset, extractMessages);
    extractInvalid.forEach((name) => markInvalid(el(ids[name]), errorId));
  }

  firstInput?.focus();
  showToast(fields.length > 0 ? '入力内容を確認してください' : general[0] || '入力内容を確認してください', true);
}

function bindFieldErrorClearing(mode) {
  for (const [field, id] of Object.entries(FORM_FIELD_IDS[mode])) {
    for (const type of ['input', 'change']) el(id).addEventListener(type, () => clearFieldError(mode, field));
  }
}

async function saveCurrentRecord() {
  if (isSavingRecord) return;
  if (!lastCalcResult) {
    showToast(lockedRefDate ? '基準時刻またはカメラ時刻が変わりました。誤差を計算し直してください' : '先に誤差を計算してください', true);
    el('calculateBtn').focus();
    return;
  }
  const result = validateRecord(recordFromForm('create'));
  if (!result.ok) {
    reportFormErrors('create', result.errors);
    return;
  }
  isSavingRecord = true;
  try {
    const id = await addRecord(result.value);
    resetRecordForm();
    requestPersistentStorage();
    showToast('記録を保存しました', false, {
      action: { label: '添付を追加', onClick: () => openAttachmentsForRecord(id) },
      duration: UNDO_TOAST_MS,
    });
  } catch (error) {
    console.error(error);
    showToast(storageErrorMessage(error, '保存に失敗しました'), true);
  } finally {
    isSavingRecord = false;
  }
}

function resetRecordForm() {
  resetLock();
  for (const id of [...CAMERA_TIME_INPUT_IDS, ...Object.values(FORM_FIELD_IDS.create)]) el(id).value = '';
  clearFieldErrors('create');
  hideDraftNotice();
  clearDraft(localStore);
  setDirty(false);
}

// 計算画面に入力済みの内容があるか。固定直後に自動入力される閲覧日だけの状態は含めない。
function hasEnteredContent() {
  if (lastCalcResult || CAMERA_TIME_INPUT_IDS.some((id) => el(id).value !== '')) return true;
  const autoViewDate = lockedRefDate ? formatDateInput(lockedRefDate) : '';
  return Object.entries(FORM_FIELD_IDS.create).some(([field, id]) => {
    const value = el(id).value;
    return value !== '' && !(field === 'viewDate' && value === autoViewDate);
  });
}

// 全入力を破棄する「リセット」。入力済みの内容があるときだけ確認する。
function requestReset() {
  if (hasEnteredContent() && !window.confirm('入力済みの内容をすべて破棄してリセットしますか？\nこの操作は取り消せません。')) return;
  resetRecordForm();
}

function showDraftNotice(message) {
  el('draftNoticeText').textContent = message;
  el('draftNotice').hidden = false;
}

function hideDraftNotice() {
  el('draftNotice').hidden = true;
}

// 計算画面の途中状態を端末内（localStorage）へ下書き保存する。誤差の値は保存しない。
function persistDraft() {
  if (!lockedRefDate) {
    clearDraft(localStore);
    return;
  }
  const fields = Object.fromEntries(
    Object.entries(FORM_FIELD_IDS.create).map(([field, id]) => [field, el(id).value]),
  );
  // 年齢の入力途中の不正値（例: -5）で下書き全体が破棄されないよう、保存側で空にする。
  if (!/^\d{1,3}$/.test(fields.witnessAge)) fields.witnessAge = '';
  saveDraft(localStore, createDraft({
    lockedAt: lockedRefDate.getTime(),
    camera: { h: el('camH').value, m: el('camM').value, s: el('camS').value },
    calculated: lastCalcResult !== null,
    panelVisible: !el('resultPanel').hidden,
    fields,
  }));
}

function restoreDraft() {
  const loaded = loadDraft(localStore);
  if (!loaded.ok) return;
  const draft = loaded.value;
  lockedRefDate = new Date(draft.lockedAt);
  showLockedUi();
  el('camH').value = draft.camera.h;
  el('camM').value = draft.camera.m;
  el('camS').value = draft.camera.s;
  for (const [field, id] of Object.entries(FORM_FIELD_IDS.create)) el(id).value = draft.fields[field];
  if (draft.panelVisible) {
    el('resultPanel').hidden = false;
    // 誤差は下書きを信用せず、固定時刻とカメラ時刻から再計算する。
    const drift = draft.calculated && !hasEmptyInput(CAMERA_TIME_INPUT_IDS)
      ? calculateDrift(formatHms(lockedRefDate), readClockInputs(CAMERA_TIME_INPUT_IDS))
      : null;
    if (drift?.ok) showCalcResult(drift.value);
    else showStaleResult();
  }
  setDirty();
  showDraftNotice(`前回の入力途中の状態を復元しました（固定した基準時刻 ${formatHms(lockedRefDate)}）。不要な場合は「リセット」で破棄できます。`);
}

function setTimeOperator(operator) {
  timeCalcOperator = operator === 'sub' ? 'sub' : 'add';
  const isAdd = timeCalcOperator === 'add';
  el('timeCalcAddBtn').classList.toggle('active', isAdd);
  el('timeCalcSubBtn').classList.toggle('active', !isAdd);
  el('timeCalcAddBtn').setAttribute('aria-pressed', String(isAdd));
  el('timeCalcSubBtn').setAttribute('aria-pressed', String(!isAdd));
}

function runTimeCalculator() {
  if (hasEmptyInput(TIME_CALC_BASE_INPUT_IDS)) {
    showToast('基準時刻を入力してください', true);
    return;
  }
  const base = readClockInputs(TIME_CALC_BASE_INPUT_IDS);
  const duration = readClockInputs(TIME_CALC_DURATION_INPUT_IDS, { emptyAsZero: true });
  const result = calculateTimeOffset(base, duration, timeCalcOperator);
  if (!result.ok) {
    showToast(firstErrorMessage(result, '時刻と時間差を確認してください'), true);
    return;
  }
  el('timeCalcResultTime').textContent = result.value.resultTime;
  el('timeCalcDayNote').textContent = result.value.dayLabel;
  el('timeCalcDayNote').classList.toggle('shifted', result.value.dayOffset !== 0);
  el('timeCalcDetail').textContent = `計算: ${base} ${timeCalcOperator === 'sub' ? '-' : '+'} ${duration}\n結果: ${result.value.dayLabel} ${result.value.resultTime}`;
  el('timeCalcResultPanel').hidden = false;
}

function switchScreen(name, { focus = false } = {}) {
  document.querySelectorAll('[role="tabpanel"]').forEach((panel) => {
    const selected = panel.id === `screen-${name}`;
    panel.hidden = !selected;
    panel.classList.toggle('active', selected);
  });
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    const selected = tab.dataset.screen === name;
    tab.classList.toggle('active', selected);
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  });
  if (name === 'history') renderHistory();
  if (name === 'info') refreshStorageCard();
  el('appBody').scrollTop = 0;
}

function handleTabKey(event) {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const current = tabs.indexOf(event.currentTarget);
  let next = null;
  if (event.key === 'ArrowRight') next = (current + 1) % tabs.length;
  if (event.key === 'ArrowLeft') next = (current - 1 + tabs.length) % tabs.length;
  if (event.key === 'Home') next = 0;
  if (event.key === 'End') next = tabs.length - 1;
  if (next === null) return;
  event.preventDefault();
  switchScreen(tabs[next].dataset.screen, { focus: true });
}

function historyMeta(record) {
  const rows = [];
  if (record.location) rows.push(`設置場所: ${record.location}`);
  if (record.viewDate) rows.push(`閲覧日: ${record.viewDate}`);
  if (record.extractDate) {
    const start = `${record.extractDate}${record.extractStartTime ? ` ${record.extractStartTime}` : ''}`;
    const end = record.extractEndDate || record.extractEndTime
      ? `${record.extractEndDate ? `${record.extractEndDate} ` : ''}${record.extractEndTime || ''}`
      : '';
    rows.push(`抽出: ${start}${end ? `〜${end}` : ''}`);
  }
  if (record.witnessName) rows.push(`立会人: ${record.witnessName}${record.witnessAge ? ` (${record.witnessAge}歳)` : ''}`);
  rows.push(`基準: ${record.refTime}　カメラ: ${record.camTime}`);
  if (record.notes) rows.push(`補足: ${record.notes}`);
  return rows.join('\n');
}

function makeButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  if (className) button.className = className;
  button.addEventListener('click', onClick);
  return button;
}

function formatRecordCount(value) {
  return `${HISTORY_COUNT_FORMATTER.format(value)}件`;
}

function formatBackupMib(value) {
  const hundredths = Math.floor((value * 100) / 1024 / 1024);
  return `${BACKUP_MIB_FORMATTER.format(hundredths / 100)} MiB`;
}

function capacityReason(label, state) {
  const message = CAPACITY_STATE_MESSAGES[state];
  return message ? `${label}が${message}` : '';
}

function renderHistoryCapacityState(capacity) {
  const warning = el('historyCapacityWarning');
  const reasons = [
    capacityReason('件数', capacity.records.state),
    capacityReason('推定容量', capacity.bytes.state),
  ].filter(Boolean);
  const levelLabel = CAPACITY_LEVEL_LABELS[capacity.level];
  const levelAction = CAPACITY_LEVEL_ACTIONS[capacity.level];

  warning.className = 'history-capacity-warning';
  if (!levelLabel || !levelAction || reasons.length === 0) {
    warning.textContent = '';
    warning.hidden = true;
    return;
  }

  warning.classList.add(`level-${capacity.level}`);
  warning.hidden = false;
  warning.textContent = `${levelLabel}：復元可能な全件バックアップの${reasons.join('。')}。${levelAction}`;
}

function updateHistoryCapacity(records) {
  const count = records.length;
  const formattedCount = formatRecordCount(count);
  try {
    const backupBytes = estimateSerializedBackupBytes(records, {
      appVersion: APP_VERSION,
      exportedAt: new Date().toISOString(),
    });
    const capacity = assessBackupCapacity({ recordCount: count, backupBytes });
    el('historyCapacitySummary').textContent = `保存済み：${formattedCount} / ${formatRecordCount(capacity.records.max)} ／ 推定バックアップ容量：${formatBackupMib(backupBytes)} / ${formatBackupMib(capacity.bytes.max)}`;
    renderHistoryCapacityState(capacity);
  } catch (error) {
    console.error('推定バックアップ容量を算出できません', error);
    const capacity = assessBackupCapacity({ recordCount: count, backupBytes: 0 });
    el('historyCapacitySummary').textContent = `保存済み：${formattedCount} / ${formatRecordCount(capacity.records.max)} ／ 推定容量を算出できません`;
    renderHistoryCapacityState(capacity);
  }
}

function renderBackupStatus(count) {
  const status = describeBackupStatus(loadBackupMeta(localStore), count);
  el('historyBackupStatus').textContent = status.label;
  el('historyBackupNotice').textContent = status.notice;
  el('historyBackupNotice').hidden = !status.needsAttention;
}

async function requestPersistentStorage() {
  try {
    const manager = navigator.storage;
    if (typeof manager?.persisted !== 'function' || typeof manager?.persist !== 'function') return;
    if (await manager.persisted()) return;
    await manager.persist();
  } catch (error) {
    console.warn('保存領域の永続化を要求できませんでした', error);
  }
}

async function refreshStorageCard() {
  const manager = navigator.storage;
  let persisted = null;
  let estimate = null;
  try {
    if (typeof manager?.persisted === 'function') persisted = await manager.persisted();
  } catch (error) {
    console.warn('永続化の状態を取得できませんでした', error);
  }
  try {
    if (typeof manager?.estimate === 'function') estimate = await manager.estimate();
  } catch (error) {
    console.warn('使用量の目安を取得できませんでした', error);
  }
  const info = describePersistence(persisted);
  el('storagePersistState').textContent = info.label;
  el('storagePersistDetail').textContent = info.detail;
  el('storageUsage').textContent = formatStorageUsage(estimate);
  el('storageAttachmentUsage').textContent = await describeAttachmentUsage();
}

async function describeAttachmentUsage() {
  try {
    const attachments = (await listAllAttachments()).filter((item) => !recordDeleter.isPending(item.recordId));
    if (attachments.length === 0) return '添付ファイル：なし（添付は端末内にだけ保存され、全件バックアップには含まれません）';
    const total = attachments.reduce((sum, item) => sum + item.size, 0);
    return `添付ファイル：${formatRecordCount(attachments.length)}（合計 ${formatFileSize(total)}）。端末内にだけ保存され、全件バックアップには含まれません。`;
  } catch (error) {
    console.warn('添付ファイルの使用量を取得できませんでした', error);
    return '添付ファイル：確認できません';
  }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

// 一覧の取得に失敗しても履歴は表示する。null は「件数不明」。
async function loadAttachmentSummary() {
  try {
    return await listAllAttachments();
  } catch (error) {
    console.warn('添付ファイルの一覧を取得できませんでした', error);
    return null;
  }
}

function countAttachmentsByRecord(attachments) {
  const counts = new Map();
  for (const item of attachments ?? []) counts.set(item.recordId, (counts.get(item.recordId) ?? 0) + 1);
  return counts;
}

function renderAttachmentNotice(total) {
  const notice = el('historyAttachmentNotice');
  if (total === 0) {
    notice.textContent = '';
    notice.hidden = true;
    return;
  }
  notice.textContent = total === null
    ? '添付ファイルの件数を確認できませんでした。全件バックアップに添付ファイルは含まれません。'
    : `全件バックアップに添付ファイルは含まれません（現在 ${formatRecordCount(total)}）。必要な添付は各記録の「編集」から1件ずつ保存してください。`;
  notice.hidden = false;
}

let historyRenderGeneration = 0;

async function renderHistory() {
  const generation = ++historyRenderGeneration;
  try {
    const [allRecords, attachments] = await Promise.all([getAllRecords(), loadAttachmentSummary()]);
    // 待機中に新しい呼び出しが始まっていたら、最新の呼び出しだけがDOMを更新する。
    if (generation !== historyRenderGeneration) return;
    // 取り消し猶予中の記録は、まだ削除していないが履歴には表示しない。
    const records = allRecords.filter((record) => !recordDeleter.isPending(record.id));
    const attachmentCounts = countAttachmentsByRecord(attachments);
    const visibleAttachmentTotal = attachments === null
      ? null
      : records.reduce((sum, record) => sum + (attachmentCounts.get(record.id) ?? 0), 0);
    renderAttachmentNotice(visibleAttachmentTotal);
    updateHistoryCapacity(records);
    lastHistoryCount = records.length;
    renderBackupStatus(records.length);
    el('clearAllBtn').hidden = records.length === 0;
    const fragment = document.createDocumentFragment();
    if (records.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = '記録はまだありません';
      fragment.append(empty);
    }
    for (const record of records) {
      const article = document.createElement('article');
      article.className = 'history-item';
      const header = document.createElement('div');
      header.className = 'history-header';
      const date = document.createElement('time');
      date.className = 'history-date';
      date.textContent = formatRecordDateTime(record.timestamp);
      const diff = document.createElement('span');
      const direction = Object.hasOwn(DIRECTION_LABELS, record.direction) ? record.direction : 'exact';
      diff.className = `history-diff ${direction}`;
      diff.textContent = record.displayVal || '誤差不明';
      header.append(date, diff);
      const meta = document.createElement('p');
      meta.className = 'history-meta';
      meta.textContent = historyMeta(record);
      const attachmentCount = attachmentCounts.get(record.id) ?? 0;
      const attachmentLine = document.createElement('p');
      attachmentLine.className = 'history-attachments';
      attachmentLine.textContent = `添付ファイル：${formatRecordCount(attachmentCount)}`;
      attachmentLine.hidden = attachmentCount === 0;
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      actions.append(
        makeButton('編集', '', (event) => openEditModal(record.id, event.currentTarget)),
        makeButton('MD出力', '', () => exportMarkdown(record.id)),
        makeButton('削除', 'delete-btn', () => removeRecord(record.id)),
      );
      article.append(header, meta, attachmentLine, actions);
      fragment.append(article);
    }
    el('historyList').replaceChildren(fragment);
  } catch (error) {
    if (generation !== historyRenderGeneration) return;
    console.error(error);
    el('historyList').replaceChildren();
    showToast('履歴の読み込みに失敗しました', true);
  }
}

// 削除の確認ダイアログは出さず、直後のトーストから元に戻せるようにする。
// 取り消し猶予の間はデータベースから消さないため、元に戻すと記録の id も添付もそのまま残る。
async function removeRecord(id) {
  let attachmentCount = 0;
  try {
    const record = await getRecord(id);
    if (!record) {
      showToast('記録が見つかりません', true);
      await renderHistory();
      return;
    }
    attachmentCount = (await listAttachments(id)).length;
  } catch (error) {
    console.error(error);
    showToast(storageErrorMessage(error, '記録の削除に失敗しました'), true);
    return;
  }
  recordDeleter.schedule(id);
  await renderHistory();
  const suffix = attachmentCount > 0 ? `（添付ファイル${attachmentCount}件を含む）` : '';
  showToast(`記録を削除しました${suffix}`, false, {
    action: { label: '元に戻す', onClick: undoRemoveRecord },
    duration: UNDO_TOAST_MS,
    focusAction: true,
  });
}

// 取り消し猶予中の削除をすべて元に戻す（続けて複数件を削除した場合も、まとめて戻す）。
async function undoRemoveRecord() {
  const restored = recordDeleter.cancelAll();
  if (restored.length === 0) {
    showToast('削除が確定したため元に戻せませんでした', true);
    return;
  }
  await renderHistory();
  showToast(restored.length > 1 ? `${restored.length}件の記録を元に戻しました` : '記録を元に戻しました');
}

// 全件削除・全件置換の確認文に入れる、消える添付の件数。0件なら触れない。
async function attachmentLossNote() {
  try {
    const count = (await listAllAttachments()).length;
    return count > 0 ? `添付ファイル${count}件もすべて削除されます（全件バックアップには含まれていません）。\n` : '';
  } catch (error) {
    console.warn('添付ファイルの件数を確認できませんでした', error);
    return '添付ファイルがある場合は、それもすべて削除されます（全件バックアップには含まれていません）。\n';
  }
}

function snapshotForm(mode) {
  return JSON.stringify(Object.values(FORM_FIELD_IDS[mode]).map((id) => el(id).value));
}

function fillEditForm(record) {
  el('editReadonly').textContent = `基準時刻: ${record.refTime}\nカメラ時刻: ${record.camTime}\n誤差: ${record.displayVal}`;
  for (const [field, id] of Object.entries(FORM_FIELD_IDS.edit)) el(id).value = record[field] || '';
}

// 非表示の祖先（例: 閉じているプレビュー）の中の要素はフォーカスできないため除く。
function focusableElements(container) {
  return [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.closest('[hidden]'));
}

function trapFocus(event, container) {
  if (event.key !== 'Tab') return;
  const focusable = focusableElements(container);
  if (focusable.length === 0) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function openDialog(container, { initialFocus, returnFocus }) {
  dialogReturnFocus = returnFocus;
  el('appRoot').inert = true;
  container.hidden = false;
  initialFocus.focus();
}

function closeDialog(container) {
  container.hidden = true;
  el('appRoot').inert = false;
  dialogReturnFocus?.focus();
  dialogReturnFocus = null;
}

function bindDialogKeys(dialog, onClose) {
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') onClose();
    else trapFocus(event, dialog);
  });
}

async function openEditModal(id, trigger, { focusAttachments = false } = {}) {
  try {
    const record = await getRecord(id);
    if (!record) throw new Error('Record not found');
    editingRecordId = id;
    editingBaseResult = {
      refTime: record.refTime,
      camTime: record.camTime,
      diffSec: record.diffSec,
      direction: record.direction,
      displayVal: record.displayVal,
    };
    fillEditForm(record);
    editSnapshot = snapshotForm('edit');
    clearFieldErrors('edit');
    resetAttachmentPanel();
    openDialog(el('editOverlay'), {
      initialFocus: focusAttachments ? el('addAttachmentBtn') : el('editLocation'),
      returnFocus: trigger,
    });
    await renderAttachmentList(id);
  } catch (error) {
    console.error(error);
    showToast('記録を読み込めませんでした', true);
  }
}

// 新規保存直後のトーストから、その記録の添付欄を開く。
async function openAttachmentsForRecord(id) {
  // 別のダイアログ（編集中の記録など）が開いている間は、入力を上書きしないよう何もしない。
  if (el('appRoot').inert) return;
  switchScreen('history');
  await openEditModal(id, el('tab-history'), { focusAttachments: true });
}

function closeEditModal() {
  resetAttachmentPanel();
  editingRecordId = null;
  editingBaseResult = null;
  editSnapshot = null;
  clearFieldErrors('edit');
  closeDialog(el('editOverlay'));
}

// 開いた時点から内容が変わっている場合だけ、破棄の確認を出してから閉じる。
function requestCloseEditModal() {
  const changed = editSnapshot !== null && snapshotForm('edit') !== editSnapshot;
  if (changed && !window.confirm('変更を破棄しますか？')) return;
  closeEditModal();
}

async function saveEditedRecord() {
  if (editingRecordId === null || isSavingRecord) return;
  isSavingRecord = true;
  try {
    const existing = await getRecord(editingRecordId);
    if (!existing) {
      showToast('記録が見つかりません', true);
      return;
    }
    const draft = recordFromForm('edit');
    draft.timestamp = existing.timestamp;
    const result = validateRecord({ ...draft, id: existing.id }, { allowId: true });
    if (!result.ok) {
      reportFormErrors('edit', result.errors);
      return;
    }
    const { id: ignored, ...data } = result.value;
    await updateRecord(editingRecordId, data);
    closeEditModal();
    await renderHistory();
    showToast('記録を更新しました');
  } catch (error) {
    console.error(error);
    showToast(storageErrorMessage(error, '更新に失敗しました'), true);
  } finally {
    isSavingRecord = false;
  }
}

function showAttachmentStatus(message, isError = false) {
  const status = el('attachmentStatus');
  status.textContent = message;
  status.classList.toggle('error', isError);
  status.hidden = message === '';
}

// 編集モーダルを開く・閉じるときに、添付欄の表示と一時データを初期化する。
function resetAttachmentPanel() {
  attachmentRenderGeneration += 1;
  closeAttachmentPreview();
  preparedShare = null;
  el('attachmentList').replaceChildren();
  showAttachmentStatus('');
}

function closeAttachmentPreview() {
  previewToken += 1;
  const image = el('attachmentPreviewImage');
  image.removeAttribute('src');
  image.alt = '';
  image.hidden = false;
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    previewUrl = null;
  }
  previewName = '';
  el('attachmentPreviewCaption').textContent = '';
  el('attachmentPreview').hidden = true;
}

function handlePreviewImageError() {
  if (!previewUrl) return;
  el('attachmentPreviewImage').hidden = true;
  el('attachmentPreviewCaption').textContent = `${previewName}：この端末では画像を表示できません。「保存」または「共有」で取り出して確認してください。`;
}

function supportsFileShare() {
  if (fileShareSupported === null) {
    try {
      fileShareSupported = typeof navigator.share === 'function'
        && typeof navigator.canShare === 'function'
        && navigator.canShare({ files: [new File(['%PDF-'], 'camsync.pdf', { type: 'application/pdf' })] });
    } catch {
      fileShareSupported = false;
    }
  }
  return fileShareSupported;
}

// disabled にするとフォーカスが外れて Esc が効かなくなるため、aria-disabled で無効を伝える。
function updateAddAttachmentButton(count) {
  const button = el('addAttachmentBtn');
  const full = count !== null && count >= ATTACHMENT_LIMITS.maxPerRecord;
  button.setAttribute('aria-disabled', String(attachmentUploadInProgress || full));
  button.textContent = attachmentUploadInProgress
    ? '添付を保存しています…'
    : full ? `添付は上限（${ATTACHMENT_LIMITS.maxPerRecord}件）に達しています` : '写真・PDFを添付';
}

function makeAttachmentButton(label, accessibleLabel, className, onClick) {
  const button = makeButton(label, className, onClick);
  button.setAttribute('aria-label', accessibleLabel);
  return button;
}

function renderAttachmentItem(meta) {
  const item = document.createElement('li');
  item.className = 'attachment-item';
  const name = document.createElement('p');
  name.className = 'attachment-name';
  name.textContent = meta.name;
  const info = document.createElement('p');
  info.className = 'attachment-info';
  info.textContent = `${ATTACHMENT_TYPE_LABELS[meta.mime] ?? '不明な種類'}・${formatFileSize(meta.size)}`;
  const actions = document.createElement('div');
  actions.className = 'attachment-actions';
  if (meta.mime.startsWith('image/')) {
    actions.append(makeAttachmentButton('プレビュー', `${meta.name}をプレビュー`, '', () => previewAttachment(meta)));
  }
  actions.append(makeAttachmentButton('保存', `${meta.name}を端末に保存`, '', () => saveAttachmentToDevice(meta)));
  if (supportsFileShare()) {
    actions.append(makeAttachmentButton('共有', `${meta.name}を共有`, '', () => shareAttachment(meta)));
  }
  actions.append(makeAttachmentButton('削除', `${meta.name}を削除`, 'delete-btn', () => removeAttachment(meta)));
  item.append(name, info, actions);
  return item;
}

async function renderAttachmentList(recordId) {
  const generation = ++attachmentRenderGeneration;
  closeAttachmentPreview();
  let attachments;
  try {
    attachments = await listAttachments(recordId);
  } catch (error) {
    if (generation !== attachmentRenderGeneration) return;
    console.error(error);
    el('attachmentList').replaceChildren();
    updateAddAttachmentButton(null);
    showAttachmentStatus(storageErrorMessage(error, '添付ファイルの一覧を読み込めませんでした'), true);
    return;
  }
  if (generation !== attachmentRenderGeneration || editingRecordId !== recordId) return;
  const fragment = document.createDocumentFragment();
  if (attachments.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'attachment-empty';
    empty.textContent = '添付ファイルはありません';
    fragment.append(empty);
  }
  attachments.forEach((meta) => fragment.append(renderAttachmentItem(meta)));
  el('attachmentList').replaceChildren(fragment);
  updateAddAttachmentButton(attachments.length);
}

// 取り出しの直前に本体を読み込む。編集中の記録が変わっていたら何もしない。
async function loadAttachmentForAction(meta) {
  const recordId = editingRecordId;
  const attachment = await getAttachment(meta.id);
  if (editingRecordId !== recordId) return null;
  if (!attachment) {
    showAttachmentStatus(`「${meta.name}」が見つかりません。一覧を更新しました。`, true);
    await renderAttachmentList(recordId);
    return null;
  }
  return attachment;
}

async function previewAttachment(meta) {
  closeAttachmentPreview();
  const token = previewToken;
  try {
    const attachment = await loadAttachmentForAction(meta);
    if (!attachment || token !== previewToken) return;
    previewUrl = URL.createObjectURL(attachment.blob);
    previewName = attachment.name;
    const image = el('attachmentPreviewImage');
    image.alt = `${attachment.name}のプレビュー`;
    image.src = previewUrl;
    el('attachmentPreviewCaption').textContent = attachment.name;
    el('attachmentPreview').hidden = false;
    el('attachmentPreviewCloseBtn').focus();
  } catch (error) {
    console.error(error);
    showAttachmentStatus(storageErrorMessage(error, '添付ファイルを読み込めませんでした'), true);
  }
}

function downloadBlob(filename, blob, revokeAfterMs = 1000) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), revokeAfterMs);
}

function downloadText(filename, text, type) {
  downloadBlob(filename, new Blob([text], { type }));
}

async function saveAttachmentToDevice(meta) {
  try {
    const attachment = await loadAttachmentForAction(meta);
    if (!attachment) return;
    downloadBlob(attachment.name, attachment.blob, ATTACHMENT_DOWNLOAD_URL_TTL_MS);
    showToast(`「${attachment.name}」を保存しました`);
  } catch (error) {
    console.error(error);
    showToast(storageErrorMessage(error, '添付ファイルを保存できませんでした'), true);
  }
}

async function shareAttachment(meta) {
  // 前回の読み込みで用意したファイルは、待たずに共有してユーザー操作の扱いを保つ。
  let file = preparedShare?.id === meta.id ? preparedShare.file : null;
  try {
    if (!file) {
      const attachment = await loadAttachmentForAction(meta);
      if (!attachment) return;
      file = new File([attachment.blob], attachment.name, { type: attachment.mime });
    }
    await navigator.share({ files: [file], title: file.name });
    preparedShare = null;
  } catch (error) {
    if (error?.name === 'AbortError') return;
    if (error?.name === 'NotAllowedError' && file) {
      preparedShare = { id: meta.id, file };
      showAttachmentStatus(`「${meta.name}」の準備ができました。もう一度「共有」を押してください。`);
      return;
    }
    console.error(error);
    showToast(storageErrorMessage(error, '添付ファイルを共有できませんでした。「保存」をお試しください'), true);
  }
}

async function removeAttachment(meta) {
  const recordId = editingRecordId;
  if (!window.confirm(`添付ファイル「${meta.name}」を削除しますか？\nこの操作は取り消せません。`)) return;
  try {
    await deleteAttachment(meta.id);
    if (preparedShare?.id === meta.id) preparedShare = null;
    showAttachmentStatus(`「${meta.name}」を削除しました。`);
  } catch (error) {
    console.error(error);
    showAttachmentStatus(storageErrorMessage(error, '添付ファイルを削除できませんでした'), true);
  }
  if (editingRecordId === recordId) {
    await renderAttachmentList(recordId);
    el('addAttachmentBtn').focus();
  }
  renderHistory();
}

function attachmentFileLabel(file) {
  return normalizeAttachmentFileName(file?.name, null);
}

function describeAttachResult(added, failures) {
  const lines = [added > 0 ? `${added}件を添付しました。` : '添付ファイルを追加できませんでした。'];
  if (failures.length > 0) {
    lines.push(`追加できなかったファイル（${failures.length}件）：`);
    failures.forEach(({ file, message }) => lines.push(`・${attachmentFileLabel(file)}：${message}`));
  }
  return lines.join('\n');
}

// 複数ファイルを1件ずつ検証・保存し、成功件数と失敗理由（ファイル名付き）をまとめて伝える。
async function attachSelectedFiles(files) {
  const recordId = editingRecordId;
  if (recordId === null || files.length === 0 || attachmentUploadInProgress) return;
  attachmentUploadInProgress = true;
  updateAddAttachmentButton(null);
  showAttachmentStatus(`${files.length}件のファイルを確認しています…`);
  let added = 0;
  const failures = [];
  try {
    let existingCount = (await listAttachments(recordId)).length;
    for (const [index, file] of files.entries()) {
      const prepared = await prepareAttachment(file, { existingCount });
      if (!prepared.ok) {
        failures.push({ file, message: firstErrorMessage(prepared, '添付できないファイルです') });
        continue;
      }
      try {
        await addAttachment(recordId, prepared.value);
        existingCount += 1;
        added += 1;
      } catch (error) {
        console.error(error);
        failures.push({ file, message: storageErrorMessage(error, '保存できませんでした') });
        // 容量不足などは後続も失敗するため、残りは試さずに理由を伝える。
        if (error?.code !== 'ATTACHMENT_LIMIT_REACHED') {
          files.slice(index + 1).forEach((rest) => failures.push({ file: rest, message: '前のファイルを保存できなかったため中止しました' }));
          break;
        }
      }
    }
  } catch (error) {
    console.error(error);
    failures.push(...files.slice(added + failures.length).map((file) => ({
      file,
      message: storageErrorMessage(error, '添付ファイルの一覧を読み込めませんでした'),
    })));
  } finally {
    attachmentUploadInProgress = false;
  }
  const message = describeAttachResult(added, failures);
  if (editingRecordId === recordId) showAttachmentStatus(message, failures.length > 0);
  // 途中で別の記録を開いていても、その記録の一覧とボタンの状態を更新する。
  if (editingRecordId !== null) await renderAttachmentList(editingRecordId);
  showToast(
    failures.length === 0 ? `${added}件を添付しました` : `${added}件を添付、${failures.length}件は追加できませんでした`,
    failures.length > 0,
  );
  if (added > 0) requestPersistentStorage();
  renderHistory();
}

async function exportMarkdown(id) {
  try {
    const record = await getRecord(id);
    if (!record) throw new Error('Record not found');
    const result = serializeRecordToMarkdown(record);
    if (!result.ok) throw new Error(firstErrorMessage(result, 'Markdownを生成できません'));
    const filename = `camsync_${formatCompactDateTime(new Date(record.timestamp))}.md`;
    downloadText(filename, result.value, 'text/markdown;charset=utf-8');
    showToast('Markdownを出力しました');
  } catch (error) {
    console.error(error);
    showToast(formatCaughtError(error, 'Markdown出力に失敗しました'), true);
  }
}

async function readFileText(file, maxBytes) {
  if (file.size > maxBytes) throw new Error(`ファイルサイズの上限は${Math.round(maxBytes / 1024 / 1024)}MiBです`);
  return file.text();
}

async function importMarkdownFile(file) {
  try {
    await recordDeleter.flush();
    const markdown = await readFileText(file, MAX_MARKDOWN_BYTES);
    const parsed = parseMarkdownRecord(markdown);
    if (!parsed.ok) throw new Error(firstErrorMessage(parsed, 'Markdown形式が不正です'));
    const existing = await getAllRecords();
    const duplicatePlan = createDuplicatePlan([parsed.value], existing, { timestampPrecision: 'minute' });
    if (duplicatePlan.duplicates.length > 0) {
      pendingDuplicateRecord = parsed.value;
      openDialog(el('duplicateDialog'), { initialFocus: el('duplicateCancelBtn'), returnFocus: el('importMarkdownBtn') });
      return;
    }
    await addRecord(parsed.value);
    await renderHistory();
    showToast('記録をインポートしました');
  } catch (error) {
    console.error(error);
    showToast(formatCaughtError(error, 'インポートに失敗しました'), true);
  }
}

function closeDuplicateDialog() {
  pendingDuplicateRecord = null;
  closeDialog(el('duplicateDialog'));
}

async function forceAddDuplicate() {
  if (!pendingDuplicateRecord) return;
  try {
    await addRecord(pendingDuplicateRecord);
    closeDuplicateDialog();
    await renderHistory();
    showToast('重複する記録を追加しました');
  } catch (error) {
    console.error(error);
    showToast('追加に失敗しました', true);
  }
}

async function backupAllRecords() {
  try {
    await recordDeleter.flush();
    const records = await getAllRecords();
    const backup = await createBackup(records, { appVersion: APP_VERSION });
    const filename = `camsync_backup_${formatCompactDateTime(new Date(), { seconds: true })}.json`;
    downloadText(filename, serializeBackup(backup), 'application/json;charset=utf-8');
    saveBackupMeta(localStore, createBackupMeta({ backedUpAt: Date.now(), recordCount: records.length }));
    renderBackupStatus(records.length);
    showToast(`${records.length}件をバックアップしました`);
  } catch (error) {
    console.error(error);
    showToast(formatCaughtError(error, 'バックアップに失敗しました'), true);
  }
}

async function prepareRestore(file) {
  try {
    const text = await readFileText(file, MAX_BACKUP_BYTES);
    const backup = await parseBackup(text);
    pendingRestoreRecords = backup.records;
    el('restoreSummary').textContent = `${backup.records.length}件の記録を検証しました。追加するか、現在の履歴を全件置換するか選択してください。`;
    openDialog(el('restoreDialog'), { initialFocus: el('restoreCancelBtn'), returnFocus: el('restoreBackupBtn') });
  } catch (error) {
    console.error(error);
    showToast(formatCaughtError(error, 'バックアップを読み取れません'), true);
  }
}

function closeRestoreDialog() {
  pendingRestoreRecords = null;
  closeDialog(el('restoreDialog'));
}

async function restoreMerge() {
  if (!pendingRestoreRecords) return;
  try {
    await recordDeleter.flush();
    const existing = await getAllRecords();
    const plan = createRestorePlan(pendingRestoreRecords, existing, { mode: 'merge' });
    await bulkAddRecords(plan.records);
    const message = `${plan.records.length}件を追加、${plan.duplicates.length}件の重複をスキップしました`;
    closeRestoreDialog();
    await renderHistory();
    showToast(message);
  } catch (error) {
    console.error(error);
    showToast(formatCaughtError(error, '復元に失敗しました'), true);
  }
}

async function restoreReplace() {
  if (!pendingRestoreRecords) return;
  await recordDeleter.flush();
  const attachmentNote = await attachmentLossNote();
  const backupNote = describeBackupStatus(loadBackupMeta(localStore), lastHistoryCount).confirmNote;
  if (!window.confirm(`現在の履歴を削除し、${pendingRestoreRecords.length}件で置き換えます。\n${attachmentNote}${backupNote}\nよろしいですか？`)) return;
  try {
    const plan = createRestorePlan(pendingRestoreRecords, [], { mode: 'replace' });
    await replaceAllRecords(plan.records);
    const count = plan.records.length;
    closeRestoreDialog();
    await renderHistory();
    showToast(`${count}件を復元しました`);
  } catch (error) {
    console.error(error);
    showToast(formatCaughtError(error, '全件置換に失敗しました'), true);
  }
}

async function clearAll() {
  await recordDeleter.flush();
  const attachmentNote = await attachmentLossNote();
  const backupNote = describeBackupStatus(loadBackupMeta(localStore), lastHistoryCount).confirmNote;
  if (!window.confirm(`すべての履歴を削除しますか？\n${attachmentNote}${backupNote}\nこの操作は取り消せません。`)) return;
  try {
    await clearAllRecords();
    await renderHistory();
    showToast('すべての履歴を削除しました');
  } catch (error) {
    console.error(error);
    showToast('履歴の削除に失敗しました', true);
  }
}

function addDays(dateValue, days) {
  const [year, month, day] = dateValue.split('-').map(Number);
  return formatDateInput(new Date(year, month - 1, day + days));
}

function bindExtractAssist(mode = 'create') {
  const ids = FORM_FIELD_IDS[mode];
  const startDate = el(ids.extractDate);
  const startTime = el(ids.extractStartTime);
  const endDate = el(ids.extractEndDate);
  const endTime = el(ids.extractEndTime);
  const assist = () => {
    if (startDate.value && startTime.value && endTime.value && !endDate.value && endTime.value < startTime.value) {
      endDate.value = addDays(startDate.value, 1);
      showToast('終了日を翌日に設定しました');
    }
  };
  for (const field of [startDate, startTime, endTime]) field.addEventListener('change', assist);
}

function bindAutoAdvance(ids, lengths) {
  ids.forEach((id, index) => {
    el(id).addEventListener('input', (event) => {
      const input = event.currentTarget;
      input.value = input.value.replace(/\D/g, '').slice(0, lengths[index]);
      if (input.value.length === lengths[index] && index < ids.length - 1) el(ids[index + 1]).focus();
    });
  });
}

function bindDirtyTracking() {
  el('appRoot').querySelectorAll('input, textarea').forEach((input) => {
    if (input.type !== 'file') input.addEventListener('input', () => setDirty());
  });
}

// カメラ時刻の変更は計算結果を無効にし、計算画面の入力はそのつど下書き保存する。
function bindCalcDraftTracking() {
  for (const id of CAMERA_TIME_INPUT_IDS) el(id).addEventListener('input', invalidateCalculation);
  for (const id of [...CAMERA_TIME_INPUT_IDS, ...Object.values(FORM_FIELD_IDS.create)]) {
    for (const type of ['input', 'change']) el(id).addEventListener(type, persistDraft);
  }
  // 未固定の画面が隠れたときに、別タブが保存した下書きを消さないよう、固定中だけ保存する。
  const persistIfLocked = () => { if (lockedRefDate) persistDraft(); };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    persistIfLocked();
    // 「削除しました」と表示した記録が、アプリを閉じたために残ることを避ける。
    recordDeleter.flush();
  });
  window.addEventListener('pagehide', persistIfLocked);
}

function isKeyboardInput(target) {
  return target instanceof Element && target.matches('input, textarea, select, [contenteditable="true"]');
}

function applyViewportAnchor() {
  viewportSyncFrame = null;
  const viewport = window.visualViewport;
  if (!viewport) return;

  const state = viewportTracker.update({
    height: viewport.height,
    offsetTop: viewport.offsetTop,
  });
  const offsetTop = Math.round(state.offsetTop * 100) / 100;
  const root = document.documentElement;
  const visibleHeight = resolveVisibleAppHeight({
    keyboardActive: state.keyboardActive,
    recoveryOffset: offsetTop,
    viewportHeight: viewport.height,
    viewportScale: viewport.scale,
  });

  if (visibleHeight !== null) {
    root.style.setProperty('--app-height', `${Math.round(visibleHeight * 100) / 100}px`);
  }
  root.style.setProperty('--visual-viewport-offset-top', `${offsetTop}px`);
  root.classList.toggle('viewport-reanchored', offsetTop > 0);

  if (keyboardWasActive && !state.keyboardActive && keyboardScrollTop !== null) {
    el('appBody').scrollTop = keyboardScrollTop;
    keyboardScrollTop = null;
  }
  keyboardWasActive = state.keyboardActive;

  if (!state.keyboardActive) {
    root.scrollTop = 0;
    document.body.scrollTop = 0;
  }
}

function scheduleViewportAnchor() {
  if (viewportSyncFrame !== null) cancelAnimationFrame(viewportSyncFrame);
  viewportSyncFrame = requestAnimationFrame(applyViewportAnchor);
}

function bindViewportRecovery() {
  const viewport = window.visualViewport;
  if (!viewport) return;

  document.addEventListener('focusin', (event) => {
    if (!isKeyboardInput(event.target)) return;
    if (viewportTracker.focus(viewport.height)) {
      keyboardScrollTop = el('appBody').scrollTop;
    }
    scheduleViewportAnchor();
  });
  document.addEventListener('focusout', (event) => {
    if (!isKeyboardInput(event.target)) return;
    setTimeout(() => {
      if (isKeyboardInput(document.activeElement)) return;
      viewportTracker.blur();
      scheduleViewportAnchor();
      setTimeout(scheduleViewportAnchor, 120);
      setTimeout(scheduleViewportAnchor, 360);
    }, 0);
  });
  viewport.addEventListener('resize', scheduleViewportAnchor);
  viewport.addEventListener('scroll', scheduleViewportAnchor);
  window.addEventListener('resize', scheduleViewportAnchor);
  scheduleViewportAnchor();
}

function showUpdate(worker) {
  waitingWorker = worker;
  el('updateBanner').hidden = false;
}

function installServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.register('./sw.js').then((registration) => {
    if (registration.waiting) showUpdate(registration.waiting);
    registration.addEventListener('updatefound', () => {
      const worker = registration.installing;
      worker?.addEventListener('statechange', () => {
        if (worker.state === 'installed' && navigator.serviceWorker.controller) showUpdate(worker);
      });
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') registration.update().catch(console.warn);
    });
  }).catch((error) => console.warn('Service worker registration failed:', error));
}

async function applyUpdate() {
  if (!waitingWorker) return;
  if ((isDirty || editingRecordId !== null) && !window.confirm('未保存の入力があります。更新すると入力内容は失われます。更新しますか？')) return;
  // 取り消し猶予中の削除は、再読み込みで取り残さないよう確定してから更新する。
  await recordDeleter.flush();
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

function bindEvents() {
  el('lockBtn').addEventListener('click', lockClock);
  el('relockBtn').addEventListener('click', relockClock);
  el('resetLockBtn').addEventListener('click', requestReset);
  el('calculateBtn').addEventListener('click', calculateCameraDrift);
  el('saveRecordBtn').addEventListener('click', saveCurrentRecord);
  el('timeCalcAddBtn').addEventListener('click', () => setTimeOperator('add'));
  el('timeCalcSubBtn').addEventListener('click', () => setTimeOperator('sub'));
  el('calculateTimeBtn').addEventListener('click', runTimeCalculator);
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    tab.addEventListener('click', () => switchScreen(tab.dataset.screen));
    tab.addEventListener('keydown', handleTabKey);
  });

  el('editCancelBtn').addEventListener('click', requestCloseEditModal);
  el('editSaveBtn').addEventListener('click', saveEditedRecord);
  el('editOverlay').addEventListener('click', (event) => {
    if (event.target === el('editOverlay')) requestCloseEditModal();
  });
  bindDialogKeys(el('editDialog'), requestCloseEditModal);
  el('addAttachmentBtn').addEventListener('click', (event) => {
    if (event.currentTarget.getAttribute('aria-disabled') === 'true') return;
    el('attachmentFileInput').click();
  });
  el('attachmentFileInput').addEventListener('change', async (event) => {
    const files = [...event.target.files];
    event.target.value = '';
    await attachSelectedFiles(files);
  });
  el('attachmentPreviewCloseBtn').addEventListener('click', () => {
    closeAttachmentPreview();
    el('addAttachmentBtn').focus();
  });
  el('attachmentPreviewImage').addEventListener('error', handlePreviewImageError);

  el('importMarkdownBtn').addEventListener('click', () => el('importFileInput').click());
  el('importFileInput').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (file) await importMarkdownFile(file);
    event.target.value = '';
  });
  el('backupAllBtn').addEventListener('click', backupAllRecords);
  el('restoreBackupBtn').addEventListener('click', () => el('restoreFileInput').click());
  el('restoreFileInput').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    if (file) await prepareRestore(file);
    event.target.value = '';
  });
  el('clearAllBtn').addEventListener('click', clearAll);

  el('duplicateCancelBtn').addEventListener('click', closeDuplicateDialog);
  el('duplicateAddBtn').addEventListener('click', forceAddDuplicate);
  bindDialogKeys(el('duplicateDialog'), closeDuplicateDialog);
  el('restoreCancelBtn').addEventListener('click', closeRestoreDialog);
  el('restoreMergeBtn').addEventListener('click', restoreMerge);
  el('restoreReplaceBtn').addEventListener('click', restoreReplace);
  bindDialogKeys(el('restoreDialog'), closeRestoreDialog);

  el('updateLaterBtn').addEventListener('click', () => { el('updateBanner').hidden = true; });
  el('updateNowBtn').addEventListener('click', applyUpdate);
  bindExtractAssist('create');
  bindExtractAssist('edit');
  bindAutoAdvance(CAMERA_TIME_INPUT_IDS, [2, 2, 2]);
  bindAutoAdvance(TIME_CALC_BASE_INPUT_IDS, [2, 2, 2]);
  bindAutoAdvance(TIME_CALC_DURATION_INPUT_IDS, [3, 2, 2]);
  bindDirtyTracking();
  bindCalcDraftTracking();
  bindFieldErrorClearing('create');
  bindFieldErrorClearing('edit');
}

el('appVersion').textContent = `v${APP_VERSION.replace(/\.0$/, '')}`;
bindEvents();
restoreDraft();
bindViewportRecovery();
setTimeOperator('add');
updateClock();
setInterval(updateClock, 250);
installServiceWorker();
// 既に記録がある状態での起動時にも、永続化されていなければ要求する。
getAllRecords()
  .then((records) => { if (records.length > 0) requestPersistentStorage(); })
  .catch((error) => console.warn('履歴の有無を確認できませんでした', error));
