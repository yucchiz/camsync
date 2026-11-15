import { ATTACHMENT_LIMITS, isAllowedAttachmentMime } from './attachment.mjs';

export const DB_NAME = 'CamSyncDB';
// v1: records / v2: attachments・attachmentBlobs を追加（records は変更しない）
export const DB_VERSION = 2;
export const STORE_NAME = 'records';
// 添付のメタ情報（Blob を含まない）。履歴描画では本体を読まずに一覧できる。
export const ATTACHMENT_STORE_NAME = 'attachments';
// 添付の本体。キーは attachments の id と同じ。
export const ATTACHMENT_BLOB_STORE_NAME = 'attachmentBlobs';
// 旧バージョンのタブが接続を閉じないとき、待つのをやめるまでの時間。
export const BLOCKED_TIMEOUT_MS = 3000;

const ALL_STORE_NAMES = Object.freeze([STORE_NAME, ATTACHMENT_STORE_NAME, ATTACHMENT_BLOB_STORE_NAME]);
const ATTACHMENT_STORE_NAMES = Object.freeze([ATTACHMENT_STORE_NAME, ATTACHMENT_BLOB_STORE_NAME]);

export class StorageError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'StorageError';
    this.code = code;
  }
}

function resolveIndexedDB(factory) {
  const resolved = factory ?? globalThis.indexedDB;
  if (!resolved || typeof resolved.open !== 'function') {
    throw new StorageError('UNAVAILABLE', 'IndexedDBを利用できない環境です');
  }
  return resolved;
}

// 足りないストアだけを作る。既存ストアは削除・再作成しないため、旧バージョンの記録を保つ。
export function upgradeSchema(db) {
  if (!db.objectStoreNames.contains(STORE_NAME)) {
    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
    store.createIndex('timestamp', 'timestamp', { unique: false });
  }
  if (!db.objectStoreNames.contains(ATTACHMENT_STORE_NAME)) {
    const store = db.createObjectStore(ATTACHMENT_STORE_NAME, { keyPath: 'id', autoIncrement: true });
    store.createIndex('recordId', 'recordId', { unique: false });
  }
  if (!db.objectStoreNames.contains(ATTACHMENT_BLOB_STORE_NAME)) {
    db.createObjectStore(ATTACHMENT_BLOB_STORE_NAME, { keyPath: 'id' });
  }
}

function openError(error) {
  if (error?.name === 'VersionError') {
    return new StorageError(
      'VERSION_MISMATCH',
      'より新しいバージョンのCamSyncでデータが更新されています。ページを再読み込みしてください',
      { cause: error },
    );
  }
  return new StorageError('OPEN_FAILED', 'データベースを開けませんでした', { cause: error });
}

export function openDB({
  indexedDBFactory,
  blockedTimeoutMs = BLOCKED_TIMEOUT_MS,
  onBlocked,
  onVersionChange,
} = {}) {
  let factory;
  try {
    factory = resolveIndexedDB(indexedDBFactory);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let request;
    let settled = false;
    let blockedTimer = null;

    const settle = (callback) => {
      if (settled) return false;
      settled = true;
      clearTimeout(blockedTimer);
      callback();
      return true;
    };

    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      settle(() => reject(openError(error)));
      return;
    }

    request.onupgradeneeded = (event) => {
      upgradeSchema(event.target.result);
    };
    // 旧バージョンのタブが接続を保持していると、アップグレードが待たされる。
    request.onblocked = () => {
      onBlocked?.();
      if (blockedTimer !== null) return;
      blockedTimer = setTimeout(() => {
        settle(() => reject(new StorageError(
          'BLOCKED',
          '別のタブで古いバージョンのCamSyncが開いているため、データベースを更新できません。他のタブを閉じてから再読み込みしてください',
        )));
      }, blockedTimeoutMs);
    };
    request.onsuccess = () => {
      const db = request.result;
      // 待つのをやめた後で開けた接続は使われないため、他のタブを妨げないよう閉じる。
      if (!settle(() => resolve(db))) {
        db.close();
        return;
      }
      db.onversionchange = () => {
        db.close();
        onVersionChange?.();
      };
    };
    request.onerror = () => {
      settle(() => reject(openError(request.error)));
    };
  });
}

const QUOTA_EXCEEDED_MESSAGE = '端末の保存容量が不足しています。不要な添付ファイルや履歴を削除してから、もう一度お試しください';

// 容量不足は汎用の失敗と区別し、利用者が対処できるメッセージにする。
function storageFailure(code, message, cause) {
  if (cause?.name === 'QuotaExceededError') {
    return new StorageError('QUOTA_EXCEEDED', QUOTA_EXCEEDED_MESSAGE, { cause });
  }
  return new StorageError(code, message, { cause });
}

function transactionError(code, message, transaction, fallback) {
  if (fallback instanceof StorageError) return fallback;
  return storageFailure(code, message, transaction?.error ?? fallback);
}

async function runTransaction(mode, schedule, {
  storeNames = [STORE_NAME],
  errorCode = 'TRANSACTION_FAILED',
  errorMessage = 'データベース処理に失敗しました',
  ...openOptions
} = {}) {
  const db = await openDB(openOptions);
  return new Promise((resolve, reject) => {
    let transaction;
    let result;
    let operationError = null;

    try {
      transaction = db.transaction(storeNames, mode);
      const scheduledResult = schedule(transaction.objectStore(storeNames[0]), transaction, (value) => {
        result = value;
      }, (error) => {
        operationError = error;
      });
      if (scheduledResult !== undefined) result = scheduledResult;
    } catch (error) {
      try {
        transaction?.abort();
      } catch {
        // The transaction may already be inactive. The original error remains the useful context.
      }
      db.close();
      reject(storageFailure(errorCode, errorMessage, error));
      return;
    }

    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    // リクエストの error が伝わる時点では transaction.error がまだ無い。原因（容量不足など）を
    // 控えるだけにし、reject は続いて起きる abort に任せる。
    transaction.onerror = (event) => {
      operationError ??= event?.target?.error ?? null;
    };
    transaction.onabort = () => {
      db.close();
      reject(transactionError(errorCode, errorMessage, transaction, operationError));
    };
  });
}

function cloneWithoutId(record) {
  const copy = { ...record };
  delete copy.id;
  return copy;
}

function assertRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new TypeError('record must be an object');
  }
}

function assertRecordArray(records) {
  if (!Array.isArray(records)) throw new TypeError('records must be an array');
  records.forEach(assertRecord);
}

export async function addRecord(record, options = {}) {
  assertRecord(record);
  return runTransaction('readwrite', (store, _transaction, setResult) => {
    const request = store.add(cloneWithoutId(record));
    request.onsuccess = () => setResult(request.result);
  }, {
    ...options,
    errorCode: 'ADD_FAILED',
    errorMessage: '記録を保存できませんでした',
  });
}

export async function getAllRecords(options = {}) {
  const records = await runTransaction('readonly', (store, _transaction, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => setResult(request.result);
  }, {
    ...options,
    errorCode: 'READ_FAILED',
    errorMessage: '履歴を読み込めませんでした',
  });
  return records.sort((left, right) => right.timestamp - left.timestamp);
}

export async function getRecord(id, options = {}) {
  return runTransaction('readonly', (store, _transaction, setResult) => {
    const request = store.get(id);
    request.onsuccess = () => setResult(request.result ?? null);
  }, {
    ...options,
    errorCode: 'READ_FAILED',
    errorMessage: '記録を読み込めませんでした',
  });
}

export async function updateRecord(id, changes, options = {}) {
  assertRecord(changes);
  return runTransaction('readwrite', (store, transaction, setResult, setOperationError) => {
    const getRequest = store.get(id);
    getRequest.onsuccess = () => {
      if (!getRequest.result) {
        setOperationError(new StorageError('NOT_FOUND', '更新する記録が見つかりません'));
        transaction.abort();
        return;
      }
      const next = { ...getRequest.result, ...changes, id: getRequest.result.id };
      const putRequest = store.put(next);
      putRequest.onsuccess = () => setResult(next);
    };
  }, {
    ...options,
    errorCode: 'UPDATE_FAILED',
    errorMessage: '記録を更新できませんでした',
  });
}

// 記録の添付（メタ情報と本体）を、呼び出し元と同じトランザクションで削除する。
function deleteAttachmentsOfRecord(transaction, recordId) {
  const metaStore = transaction.objectStore(ATTACHMENT_STORE_NAME);
  const blobStore = transaction.objectStore(ATTACHMENT_BLOB_STORE_NAME);
  const request = metaStore.index('recordId').getAllKeys(recordId);
  request.onsuccess = () => {
    request.result.forEach((key) => {
      metaStore.delete(key);
      blobStore.delete(key);
    });
  };
}

function clearAllStores(transaction) {
  ALL_STORE_NAMES.forEach((name) => transaction.objectStore(name).clear());
}

export async function deleteRecord(id, options = {}) {
  return runTransaction('readwrite', (store, transaction) => {
    store.delete(id);
    deleteAttachmentsOfRecord(transaction, id);
  }, {
    ...options,
    storeNames: ALL_STORE_NAMES,
    errorCode: 'DELETE_FAILED',
    errorMessage: '記録を削除できませんでした',
  });
}

export async function clearAllRecords(options = {}) {
  return runTransaction('readwrite', (_store, transaction) => {
    clearAllStores(transaction);
  }, {
    ...options,
    storeNames: ALL_STORE_NAMES,
    errorCode: 'CLEAR_FAILED',
    errorMessage: '履歴を削除できませんでした',
  });
}

export async function bulkAddRecords(records, options = {}) {
  assertRecordArray(records);
  return runTransaction('readwrite', (store) => {
    const ids = [];
    records.forEach((record) => {
      const request = store.add(cloneWithoutId(record));
      request.onsuccess = () => ids.push(request.result);
    });
    return ids;
  }, {
    ...options,
    errorCode: 'BULK_ADD_FAILED',
    errorMessage: '記録を一括追加できませんでした',
  });
}

export async function replaceAllRecords(records, options = {}) {
  assertRecordArray(records);
  return runTransaction('readwrite', (store, transaction) => {
    const keys = [];
    // 復元後の記録は旧 id を再利用し得るため、旧添付が別の記録に付かないよう全件消す。
    clearAllStores(transaction);
    records.forEach((record) => {
      const request = store.put({ ...record });
      request.onsuccess = () => keys.push(request.result);
    });
    return keys;
  }, {
    ...options,
    errorCode: 'REPLACE_FAILED',
    errorMessage: '履歴を置き換えられませんでした',
    storeNames: ALL_STORE_NAMES,
  });
}

function isValidFileName(name) {
  return typeof name === 'string'
    && name.trim() !== ''
    && [...name].length <= ATTACHMENT_LIMITS.maxFileNameLength;
}

// prepareAttachment（lib/attachment.mjs）を通した値だけを受け付ける。保存直前にも再確認する。
function assertAttachment(recordId, attachment) {
  if (!Number.isSafeInteger(recordId)) throw new TypeError('recordId must be an integer');
  if (attachment === null || typeof attachment !== 'object' || Array.isArray(attachment)) {
    throw new TypeError('attachment must be an object');
  }
  const { name, mime, size, blob } = attachment;
  if (!isValidFileName(name)) throw new TypeError('attachment.name is invalid');
  if (!isAllowedAttachmentMime(mime)) throw new TypeError('attachment.mime is not allowed');
  if (!(blob instanceof Blob)) throw new TypeError('attachment.blob must be a Blob');
  if (!Number.isSafeInteger(size) || size <= 0 || size > ATTACHMENT_LIMITS.maxBytes || blob.size !== size) {
    throw new TypeError('attachment.size is invalid');
  }
}

function compareAttachments(left, right) {
  return left.createdAt - right.createdAt || left.id - right.id;
}

export async function addAttachment(recordId, attachment, options = {}) {
  assertAttachment(recordId, attachment);
  const { name, mime, size, blob } = attachment;
  const createdAt = options.now ?? Date.now();

  return runTransaction('readwrite', (records, transaction, setResult, setOperationError) => {
    const metaStore = transaction.objectStore(ATTACHMENT_STORE_NAME);
    const blobStore = transaction.objectStore(ATTACHMENT_BLOB_STORE_NAME);
    const fail = (error) => {
      setOperationError(error);
      transaction.abort();
    };

    const recordRequest = records.get(recordId);
    recordRequest.onsuccess = () => {
      if (!recordRequest.result) {
        fail(new StorageError('NOT_FOUND', '添付先の記録が見つかりません'));
        return;
      }
      // 件数は同じトランザクション内で数え、同時追加でも上限を超えないようにする。
      const countRequest = metaStore.index('recordId').count(recordId);
      countRequest.onsuccess = () => {
        if (countRequest.result >= ATTACHMENT_LIMITS.maxPerRecord) {
          fail(new StorageError(
            'ATTACHMENT_LIMIT_REACHED',
            `添付は1件の記録につき${ATTACHMENT_LIMITS.maxPerRecord}件までです`,
          ));
          return;
        }
        const meta = { recordId, name, mime, size, createdAt };
        const metaRequest = metaStore.add(meta);
        metaRequest.onsuccess = () => {
          const id = metaRequest.result;
          blobStore.add({ id, blob });
          setResult({ id, ...meta });
        };
      };
    };
  }, {
    ...options,
    storeNames: ALL_STORE_NAMES,
    errorCode: 'ATTACHMENT_ADD_FAILED',
    errorMessage: '添付ファイルを保存できませんでした',
  });
}

export async function listAttachments(recordId, options = {}) {
  const attachments = await runTransaction('readonly', (store, _transaction, setResult) => {
    const request = store.index('recordId').getAll(recordId);
    request.onsuccess = () => setResult(request.result);
  }, {
    ...options,
    storeNames: [ATTACHMENT_STORE_NAME],
    errorCode: 'ATTACHMENT_READ_FAILED',
    errorMessage: '添付ファイルの一覧を読み込めませんでした',
  });
  return attachments.sort(compareAttachments);
}

// 全記録の添付メタ情報。履歴で件数を表示するときに、Blob 本体を読まずに使う。
export async function listAllAttachments(options = {}) {
  const attachments = await runTransaction('readonly', (store, _transaction, setResult) => {
    const request = store.getAll();
    request.onsuccess = () => setResult(request.result);
  }, {
    ...options,
    storeNames: [ATTACHMENT_STORE_NAME],
    errorCode: 'ATTACHMENT_READ_FAILED',
    errorMessage: '添付ファイルの一覧を読み込めませんでした',
  });
  return attachments.sort((left, right) => left.recordId - right.recordId || compareAttachments(left, right));
}

export async function getAttachment(id, options = {}) {
  return runTransaction('readonly', (metaStore, transaction, setResult, setOperationError) => {
    const metaRequest = metaStore.get(id);
    const blobRequest = transaction.objectStore(ATTACHMENT_BLOB_STORE_NAME).get(id);
    blobRequest.onsuccess = () => {
      const meta = metaRequest.result;
      if (!meta) {
        setResult(null);
        return;
      }
      if (!(blobRequest.result?.blob instanceof Blob)) {
        setOperationError(new StorageError('ATTACHMENT_MISSING', '添付ファイルの本体が見つかりません'));
        transaction.abort();
        return;
      }
      setResult({ ...meta, blob: blobRequest.result.blob });
    };
  }, {
    ...options,
    storeNames: ATTACHMENT_STORE_NAMES,
    errorCode: 'ATTACHMENT_READ_FAILED',
    errorMessage: '添付ファイルを読み込めませんでした',
  });
}

export async function deleteAttachment(id, options = {}) {
  return runTransaction('readwrite', (metaStore, transaction) => {
    metaStore.delete(id);
    transaction.objectStore(ATTACHMENT_BLOB_STORE_NAME).delete(id);
  }, {
    ...options,
    storeNames: ATTACHMENT_STORE_NAMES,
    errorCode: 'ATTACHMENT_DELETE_FAILED',
    errorMessage: '添付ファイルを削除できませんでした',
  });
}

// 個別削除の取り消し猶予。猶予中はデータベースから消さず、delayMs 後（または flush 時）に
// deleteRecord で記録と添付をまとめて確定削除する。画面側はアプリが背面に回るときに flush して確定する。確定前に強制終了された場合、記録は残る。
// 確定削除の実行中も isPending は true のままにし、完了までは履歴に再表示しない。
export function createDeferredRecordDeleter({
  delayMs,
  deleteFn = deleteRecord,
  onCommitError = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  ...storageOptions
} = {}) {
  if (!Number.isFinite(delayMs) || delayMs < 0) throw new TypeError('delayMs must be a non-negative number');
  // id -> { timer, running: Promise | null }
  const entries = new Map();

  function commit(id) {
    const entry = entries.get(id);
    if (!entry) return Promise.resolve();
    if (entry.running) return entry.running;
    clearTimer(entry.timer);
    entry.running = (async () => {
      try {
        await deleteFn(id, storageOptions);
      } catch (error) {
        onCommitError(id, error);
      } finally {
        entries.delete(id);
      }
    })();
    return entry.running;
  }

  return {
    schedule(id) {
      if (entries.has(id)) return;
      entries.set(id, { timer: setTimer(() => { commit(id); }, delayMs), running: null });
    },
    // 猶予中なら削除を取りやめて true を返す。確定済み・実行中は false。
    cancel(id) {
      const entry = entries.get(id);
      if (!entry || entry.running) return false;
      clearTimer(entry.timer);
      entries.delete(id);
      return true;
    },
    // 猶予中の削除をすべて取りやめ、取りやめた id を返す。実行中の削除は対象外。
    cancelAll() {
      const cancelled = [];
      for (const [id, entry] of entries) {
        if (entry.running) continue;
        clearTimer(entry.timer);
        entries.delete(id);
        cancelled.push(id);
      }
      return cancelled;
    },
    hasCancellable() {
      return [...entries.values()].some((entry) => !entry.running);
    },
    isPending(id) {
      return entries.has(id);
    },
    // 猶予中の削除をすべて確定し、実行中の削除の完了まで待つ。失敗は onCommitError へ通知する。
    async flush() {
      await Promise.all([...entries.keys()].map(commit));
    },
  };
}
