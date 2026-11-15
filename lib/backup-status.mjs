import { formatRecordDateTime } from './time.mjs';
import { readItem, writeItem } from './safe-storage.mjs';

export const BACKUP_META_KEY = 'camsync.lastBackup.v1';

export function createBackupMeta({ backedUpAt, recordCount }) {
  return { backedUpAt, recordCount };
}

export function parseBackupMeta(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null;
  const { backedUpAt, recordCount } = data;
  if (!Number.isSafeInteger(backedUpAt) || backedUpAt <= 0) return null;
  if (!Number.isSafeInteger(recordCount) || recordCount < 0) return null;
  return createBackupMeta({ backedUpAt, recordCount });
}

export function loadBackupMeta(storage) {
  return parseBackupMeta(readItem(storage, BACKUP_META_KEY));
}

export function saveBackupMeta(storage, meta) {
  return writeItem(storage, BACKUP_META_KEY, JSON.stringify(meta));
}

// 最終バックアップ後の「追加件数」は現在件数との差で見積もる。削除と追加が混在した場合は正確ではない。
export function describeBackupStatus(meta, currentCount) {
  if (!meta) {
    const needsAttention = currentCount > 0;
    return {
      label: '最終バックアップ：未実施',
      addedSince: null,
      needsAttention,
      notice: needsAttention ? '全件バックアップは未実施です。端末のデータが消えると履歴を戻せません。' : '',
      confirmNote: '最終バックアップ：未実施です。'
    };
  }

  const when = formatRecordDateTime(meta.backedUpAt) ?? '日時不明';
  const addedSince = Math.max(0, currentCount - meta.recordCount);
  const needsAttention = addedSince > 0;
  return {
    label: `最終バックアップ：${when}（${needsAttention ? `その後 ${addedSince} 件追加` : 'その後の追加なし'}）`,
    addedSince,
    needsAttention,
    notice: needsAttention ? `前回のバックアップ後に ${addedSince} 件追加されています。バックアップを取り直してください。` : '',
    confirmNote: needsAttention
      ? `前回のバックアップ（${when}）後に${addedSince}件追加されており、その分は未バックアップです。`
      : `最終バックアップ：${when}（以降の追加なし）です。`
  };
}
