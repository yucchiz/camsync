// localStorage 互換のストレージを例外なしで扱う。プライベートモードや容量超過でも呼び出し側を落とさない。
export function readItem(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

export function writeItem(storage, key, value) {
  try {
    if (!storage) return false;
    storage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

export function removeItem(storage, key) {
  try {
    storage?.removeItem(key);
  } catch {
    // 消せなくても動作を続ける。
  }
}
