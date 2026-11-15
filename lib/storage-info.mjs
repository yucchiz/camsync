const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

// persisted: true | false | null（API が使えない環境）
export function describePersistence(persisted) {
  if (persisted === true) {
    return { state: 'granted', label: '許可済み', detail: '容量が不足してもブラウザが自動で削除しにくい状態です。' };
  }
  if (persisted === false) {
    return {
      state: 'denied',
      label: '未許可',
      detail: '端末の空き容量が少ないとき、ブラウザが履歴を自動で削除する可能性があります。定期的に全件バックアップしてください。'
    };
  }
  return { state: 'unsupported', label: '非対応', detail: 'この環境では保存領域の永続化状態を確認できません。定期的に全件バックアップしてください。' };
}

function formatBytes(bytes) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(unit >= 3 && value >= 1 && value < 10 ? 2 : 1)} ${UNITS[unit]}`;
}

function isByteCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

export function formatStorageUsage(estimate) {
  if (!estimate || !isByteCount(estimate.usage)) return '使用量の目安：取得できません';
  const usage = formatBytes(estimate.usage);
  return isByteCount(estimate.quota) && estimate.quota > 0
    ? `使用量の目安：${usage} / ${formatBytes(estimate.quota)}`
    : `使用量の目安：${usage}`;
}
