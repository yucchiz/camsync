import {
  calculateDrift,
  calculateTimeOffset,
  normalizeExtractRange,
  validateExtractRange,
} from './lib/time.mjs';
import { validateRecord } from './lib/record.mjs';
import {
  MAX_MARKDOWN_BYTES,
  parseMarkdownRecord,
  serializeRecordToMarkdown,
} from './lib/markdown.mjs';
import {
  addRecord,
  bulkAddRecords,
  clearAllRecords,
  deleteRecord,
  getAllRecords,
  getRecord,
  replaceAllRecords,
  updateRecord,
} from './lib/storage.mjs';
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

const APP_VERSION = '2.7.0';
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
const el = (id) => document.getElementById(id);

let lockedRefDate = null;
let lastCalcResult = null;
let timeCalcOperator = 'add';
let editingRecordId = null;
let editingBaseResult = null;
let editReturnFocus = null;
let pendingDuplicateRecord = null;
let pendingRestoreRecords = null;
let restoreReturnFocus = null;
let duplicateReturnFocus = null;
let waitingWorker = null;
let isDirty = false;
let toastTimer = null;

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatHms(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function formatDateInput(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function formatRecordDateTime(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return '日時不明';
  return `${date.getFullYear()}/${pad2(date.getMonth() + 1)}/${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function showToast(message, isError = false) {
  const toast = el('toast');
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.setAttribute('role', isError ? 'alert' : 'status');
  toast.setAttribute('aria-live', isError ? 'assertive' : 'polite');
  toast.classList.add('show');
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
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

function setDirty(value = true) {
  isDirty = value;
}

function updateClock() {
  const now = new Date();
  if (!lockedRefDate) el('liveClock').textContent = formatHms(now);
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  el('liveDate').textContent = `${now.getFullYear()}/${pad2(now.getMonth() + 1)}/${pad2(now.getDate())} (${weekdays[now.getDay()]})`;
}

function lockClock() {
  if (lockedRefDate) return;
  lockedRefDate = new Date();
  const value = formatHms(lockedRefDate);
  el('liveClock').textContent = value;
  el('liveClock').classList.add('locked');
  el('lockBtn').textContent = '固定済み';
  el('lockBtn').classList.add('locked');
  el('lockBtn').setAttribute('aria-pressed', 'true');
  el('lockedTime').textContent = value;
  el('lockedDisplay').hidden = false;
  el('viewDate').value = formatDateInput(lockedRefDate);
  setDirty();
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
  if (!preserveDirty) setDirty(false);
}

function cameraTimeValue() {
  return `${el('camH').value.padStart(2, '0')}:${el('camM').value.padStart(2, '0')}:${el('camS').value.padStart(2, '0')}`;
}

function calculateCameraDrift() {
  if (!lockedRefDate) {
    showToast('先に基準時刻を固定してください', true);
    return;
  }
  if ([el('camH'), el('camM'), el('camS')].some((input) => input.value === '')) {
    showToast('カメラ時刻を入力してください', true);
    return;
  }
  const result = calculateDrift(formatHms(lockedRefDate), cameraTimeValue());
  if (!result.ok) {
    showToast(firstErrorMessage(result, 'カメラ時刻を24時間表記で入力してください'), true);
    return;
  }
  lastCalcResult = result.value;
  const direction = lastCalcResult.direction;
  el('resultDir').textContent = DIRECTION_LABELS[direction];
  el('resultDir').className = `result-direction ${direction}`;
  el('resultVal').textContent = lastCalcResult.displayVal;
  el('resultVal').className = `result-value ${direction}`;
  const sign = lastCalcResult.diffSec > 0 ? '+' : lastCalcResult.diffSec < 0 ? '-' : '±';
  el('resultUnit').textContent = `（${sign}${Math.abs(lastCalcResult.diffSec)}秒）`;
  el('resultDetail').textContent = `基準: ${lastCalcResult.refTime}\nカメラ: ${lastCalcResult.camTime}`;
  el('resultPanel').hidden = false;
  setDirty();
}

function recordFromForm(mode = 'create') {
  const ids = mode === 'edit'
    ? {
        location: 'editLocation', viewDate: 'editViewDate', extractDate: 'editExtractDate',
        extractStartTime: 'editExtractStartTime', extractEndDate: 'editExtractEndDate',
        extractEndTime: 'editExtractEndTime', witnessName: 'editWitnessName',
        witnessAge: 'editWitnessAge', notes: 'editNotes',
      }
    : {
        location: 'camLocation', viewDate: 'viewDate', extractDate: 'extractDate',
        extractStartTime: 'extractStartTime', extractEndDate: 'extractEndDate',
        extractEndTime: 'extractEndTime', witnessName: 'witnessName',
        witnessAge: 'witnessAge', notes: 'notes',
      };
  const range = normalizeExtractRange({
    startDate: el(ids.extractDate).value,
    startTime: el(ids.extractStartTime).value,
    endDate: el(ids.extractEndDate).value,
    endTime: el(ids.extractEndTime).value,
  });
  const calculation = mode === 'edit' ? editingBaseResult : lastCalcResult;
  return {
    timestamp: Date.now(),
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

async function saveCurrentRecord() {
  if (!lastCalcResult) {
    showToast('先に誤差を計算してください', true);
    return;
  }
  const result = validateRecord(recordFromForm('create'));
  if (!result.ok) {
    showToast(firstErrorMessage(result, '入力内容を確認してください'), true);
    return;
  }
  try {
    await addRecord(result.value);
    showToast('記録を保存しました');
    resetRecordForm();
  } catch (error) {
    console.error(error);
    showToast('保存に失敗しました', true);
  }
}

function resetRecordForm() {
  resetLock();
  for (const id of [
    'camH', 'camM', 'camS', 'camLocation', 'viewDate', 'extractDate',
    'extractStartTime', 'extractEndDate', 'extractEndTime', 'witnessName',
    'witnessAge', 'notes',
  ]) el(id).value = '';
  setDirty(false);
}

function durationValue() {
  const hours = el('timeCalcDiffH').value || '0';
  const minutes = el('timeCalcDiffM').value || '0';
  const seconds = el('timeCalcDiffS').value || '0';
  return `${hours.padStart(2, '0')}:${minutes.padStart(2, '0')}:${seconds.padStart(2, '0')}`;
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
  if ([el('timeCalcH'), el('timeCalcM'), el('timeCalcS')].some((input) => input.value === '')) {
    showToast('基準時刻を入力してください', true);
    return;
  }
  const base = `${el('timeCalcH').value.padStart(2, '0')}:${el('timeCalcM').value.padStart(2, '0')}:${el('timeCalcS').value.padStart(2, '0')}`;
  const result = calculateTimeOffset(base, durationValue(), timeCalcOperator);
  if (!result.ok) {
    showToast(firstErrorMessage(result, '時刻と時間差を確認してください'), true);
    return;
  }
  el('timeCalcResultTime').textContent = result.value.resultTime;
  el('timeCalcDayNote').textContent = result.value.dayLabel;
  el('timeCalcDayNote').classList.toggle('shifted', result.value.dayOffset !== 0);
  el('timeCalcDetail').textContent = `計算: ${base} ${timeCalcOperator === 'sub' ? '-' : '+'} ${durationValue()}\n結果: ${result.value.dayLabel} ${result.value.resultTime}`;
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

async function renderHistory() {
  const list = el('historyList');
  list.replaceChildren();
  try {
    const records = await getAllRecords();
    updateHistoryCapacity(records);
    el('clearAllBtn').hidden = records.length === 0;
    if (records.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'history-empty';
      empty.textContent = '記録はまだありません';
      list.append(empty);
      return;
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
      const direction = ['ahead', 'behind', 'exact'].includes(record.direction) ? record.direction : 'exact';
      diff.className = `history-diff ${direction}`;
      diff.textContent = record.displayVal || '誤差不明';
      header.append(date, diff);
      const meta = document.createElement('p');
      meta.className = 'history-meta';
      meta.textContent = historyMeta(record);
      const actions = document.createElement('div');
      actions.className = 'history-actions';
      actions.append(
        makeButton('編集', '', (event) => openEditModal(record.id, event.currentTarget)),
        makeButton('MD出力', '', () => exportMarkdown(record.id)),
        makeButton('削除', 'delete-btn', () => removeRecord(record.id)),
      );
      article.append(header, meta, actions);
      list.append(article);
    }
  } catch (error) {
    console.error(error);
    showToast('履歴の読み込みに失敗しました', true);
  }
}

async function removeRecord(id) {
  if (!window.confirm('この記録を削除しますか？\nこの操作は取り消せません。')) return;
  try {
    await deleteRecord(id);
    await renderHistory();
    showToast('記録を削除しました');
  } catch (error) {
    console.error(error);
    showToast('記録の削除に失敗しました', true);
  }
}

function fillEditForm(record) {
  el('editReadonly').textContent = `基準時刻: ${record.refTime}\nカメラ時刻: ${record.camTime}\n誤差: ${record.displayVal}`;
  el('editLocation').value = record.location || '';
  el('editViewDate').value = record.viewDate || '';
  el('editExtractDate').value = record.extractDate || '';
  el('editExtractStartTime').value = record.extractStartTime || '';
  el('editExtractEndDate').value = record.extractEndDate || '';
  el('editExtractEndTime').value = record.extractEndTime || '';
  el('editWitnessName').value = record.witnessName || '';
  el('editWitnessAge').value = record.witnessAge || '';
  el('editNotes').value = record.notes || '';
}

function focusableElements(container) {
  return [...container.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((node) => !node.hidden);
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

async function openEditModal(id, trigger) {
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
    editReturnFocus = trigger;
    el('appRoot').inert = true;
    el('editOverlay').hidden = false;
    el('editLocation').focus();
  } catch (error) {
    console.error(error);
    showToast('記録を読み込めませんでした', true);
  }
}

function closeEditModal() {
  editingRecordId = null;
  editingBaseResult = null;
  el('editOverlay').hidden = true;
  el('appRoot').inert = false;
  editReturnFocus?.focus();
  editReturnFocus = null;
}

async function saveEditedRecord() {
  if (editingRecordId === null) return;
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
      showToast(firstErrorMessage(result, '入力内容を確認してください'), true);
      return;
    }
    const { id: ignored, ...data } = result.value;
    await updateRecord(editingRecordId, data);
    closeEditModal();
    await renderHistory();
    showToast('記録を更新しました');
  } catch (error) {
    console.error(error);
    showToast('更新に失敗しました', true);
  }
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportMarkdown(id) {
  try {
    const record = await getRecord(id);
    if (!record) throw new Error('Record not found');
    const result = serializeRecordToMarkdown(record);
    if (!result.ok) throw new Error(firstErrorMessage(result, 'Markdownを生成できません'));
    const date = new Date(record.timestamp);
    const filename = `camsync_${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}_${pad2(date.getHours())}${pad2(date.getMinutes())}.md`;
    downloadText(filename, result.value, 'text/markdown;charset=utf-8');
    showToast('Markdownを出力しました');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'Markdown出力に失敗しました', true);
  }
}

async function readFileText(file, maxBytes) {
  if (file.size > maxBytes) throw new Error(`ファイルサイズの上限は${Math.round(maxBytes / 1024 / 1024)}MiBです`);
  return file.text();
}

async function importMarkdownFile(file) {
  try {
    const markdown = await readFileText(file, MAX_MARKDOWN_BYTES);
    const parsed = parseMarkdownRecord(markdown);
    if (!parsed.ok) throw new Error(firstErrorMessage(parsed, 'Markdown形式が不正です'));
    const existing = await getAllRecords();
    const duplicatePlan = createDuplicatePlan([parsed.value], existing, { timestampPrecision: 'minute' });
    if (duplicatePlan.duplicates.length > 0) {
      pendingDuplicateRecord = parsed.value;
      duplicateReturnFocus = el('importMarkdownBtn');
      el('appRoot').inert = true;
      el('duplicateDialog').hidden = false;
      el('duplicateCancelBtn').focus();
      return;
    }
    await addRecord(parsed.value);
    await renderHistory();
    showToast('記録をインポートしました');
  } catch (error) {
    console.error(error);
    showToast(error.message || 'インポートに失敗しました', true);
  }
}

function closeDuplicateDialog() {
  pendingDuplicateRecord = null;
  el('duplicateDialog').hidden = true;
  el('appRoot').inert = false;
  duplicateReturnFocus?.focus();
  duplicateReturnFocus = null;
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
    const records = await getAllRecords();
    const backup = await createBackup(records, { appVersion: APP_VERSION });
    const now = new Date();
    const filename = `camsync_backup_${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}_${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}.json`;
    downloadText(filename, serializeBackup(backup), 'application/json;charset=utf-8');
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
    restoreReturnFocus = el('restoreBackupBtn');
    el('appRoot').inert = true;
    el('restoreDialog').hidden = false;
    el('restoreCancelBtn').focus();
  } catch (error) {
    console.error(error);
    showToast(formatCaughtError(error, 'バックアップを読み取れません'), true);
  }
}

function closeRestoreDialog() {
  pendingRestoreRecords = null;
  el('restoreDialog').hidden = true;
  el('appRoot').inert = false;
  restoreReturnFocus?.focus();
  restoreReturnFocus = null;
}

async function restoreMerge() {
  if (!pendingRestoreRecords) return;
  try {
    const existing = await getAllRecords();
    const plan = createRestorePlan(pendingRestoreRecords, existing, { mode: 'merge' });
    await bulkAddRecords(plan.records);
    const message = `${plan.records.length}件を追加、${plan.duplicates.length}件の重複をスキップしました`;
    closeRestoreDialog();
    await renderHistory();
    showToast(message);
  } catch (error) {
    console.error(error);
    showToast(error.message || '復元に失敗しました', true);
  }
}

async function restoreReplace() {
  if (!pendingRestoreRecords) return;
  if (!window.confirm(`現在の履歴を削除し、${pendingRestoreRecords.length}件で置き換えます。よろしいですか？`)) return;
  try {
    const plan = createRestorePlan(pendingRestoreRecords, [], { mode: 'replace' });
    await replaceAllRecords(plan.records);
    const count = plan.records.length;
    closeRestoreDialog();
    await renderHistory();
    showToast(`${count}件を復元しました`);
  } catch (error) {
    console.error(error);
    showToast(error.message || '全件置換に失敗しました', true);
  }
}

async function clearAll() {
  if (!window.confirm('すべての履歴を削除しますか？\nこの操作は取り消せません。')) return;
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

function bindExtractAssist(prefix = '') {
  const stem = prefix === 'edit' ? 'editExtract' : 'extract';
  const startDate = el(`${stem}Date`);
  const startTime = el(`${stem}StartTime`);
  const endDate = el(`${stem}EndDate`);
  const endTime = el(`${stem}EndTime`);
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

function applyUpdate() {
  if (!waitingWorker) return;
  if ((isDirty || editingRecordId !== null) && !window.confirm('未保存の入力があります。更新すると入力内容は失われます。更新しますか？')) return;
  navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  waitingWorker.postMessage({ type: 'SKIP_WAITING' });
}

function bindEvents() {
  el('lockBtn').addEventListener('click', lockClock);
  el('resetLockBtn').addEventListener('click', () => resetLock());
  el('calculateBtn').addEventListener('click', calculateCameraDrift);
  el('saveRecordBtn').addEventListener('click', saveCurrentRecord);
  el('timeCalcAddBtn').addEventListener('click', () => setTimeOperator('add'));
  el('timeCalcSubBtn').addEventListener('click', () => setTimeOperator('sub'));
  el('calculateTimeBtn').addEventListener('click', runTimeCalculator);
  document.querySelectorAll('[role="tab"]').forEach((tab) => {
    tab.addEventListener('click', () => switchScreen(tab.dataset.screen));
    tab.addEventListener('keydown', handleTabKey);
  });

  el('editCancelBtn').addEventListener('click', closeEditModal);
  el('editSaveBtn').addEventListener('click', saveEditedRecord);
  el('editOverlay').addEventListener('click', (event) => {
    if (event.target === el('editOverlay')) closeEditModal();
  });
  el('editDialog').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeEditModal();
    else trapFocus(event, el('editDialog'));
  });

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
  el('duplicateDialog').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeDuplicateDialog();
    else trapFocus(event, el('duplicateDialog'));
  });
  el('restoreCancelBtn').addEventListener('click', closeRestoreDialog);
  el('restoreMergeBtn').addEventListener('click', restoreMerge);
  el('restoreReplaceBtn').addEventListener('click', restoreReplace);
  el('restoreDialog').addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeRestoreDialog();
    else trapFocus(event, el('restoreDialog'));
  });

  el('updateLaterBtn').addEventListener('click', () => { el('updateBanner').hidden = true; });
  el('updateNowBtn').addEventListener('click', applyUpdate);
  bindExtractAssist('');
  bindExtractAssist('edit');
  bindAutoAdvance(['camH', 'camM', 'camS'], [2, 2, 2]);
  bindAutoAdvance(['timeCalcH', 'timeCalcM', 'timeCalcS'], [2, 2, 2]);
  bindAutoAdvance(['timeCalcDiffH', 'timeCalcDiffM', 'timeCalcDiffS'], [3, 2, 2]);
  bindDirtyTracking();
}

el('appVersion').textContent = `v${APP_VERSION.replace(/\.0$/, '')}`;
bindEvents();
setTimeOperator('add');
updateClock();
setInterval(updateClock, 250);
installServiceWorker();
