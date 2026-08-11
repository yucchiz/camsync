export const DB_NAME = 'CamSyncDB';
export const DB_VERSION = 1;
export const STORE_NAME = 'records';

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

export function openDB({ indexedDBFactory } = {}) {
  let factory;
  try {
    factory = resolveIndexedDB(indexedDBFactory);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let request;
    try {
      request = factory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(new StorageError('OPEN_FAILED', 'データベースを開けませんでした', { cause: error }));
      return;
    }

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('timestamp', 'timestamp', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    request.onerror = () => {
      reject(new StorageError('OPEN_FAILED', 'データベースを開けませんでした', {
        cause: request.error,
      }));
    };
  });
}

function transactionError(code, message, transaction, fallback) {
  if (fallback instanceof StorageError) return fallback;
  return new StorageError(code, message, { cause: transaction.error ?? fallback });
}

async function runTransaction(mode, schedule, {
  indexedDBFactory,
  errorCode = 'TRANSACTION_FAILED',
  errorMessage = 'データベース処理に失敗しました',
} = {}) {
  const db = await openDB({ indexedDBFactory });
  return new Promise((resolve, reject) => {
    let transaction;
    let result;
    let operationError = null;

    try {
      transaction = db.transaction(STORE_NAME, mode);
      const scheduledResult = schedule(transaction.objectStore(STORE_NAME), transaction, (value) => {
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
      reject(new StorageError(errorCode, errorMessage, { cause: error }));
      return;
    }

    transaction.oncomplete = () => {
      db.close();
      resolve(result);
    };
    transaction.onerror = () => {
      db.close();
      reject(transactionError(errorCode, errorMessage, transaction, operationError));
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
  let request;
  return runTransaction('readwrite', (store, _transaction, setResult) => {
    request = store.add(cloneWithoutId(record));
    request.onsuccess = () => setResult(request.result);
  }, {
    ...options,
    errorCode: 'ADD_FAILED',
    errorMessage: '記録を保存できませんでした',
  });
}

export async function getAllRecords(options = {}) {
  let request;
  const records = await runTransaction('readonly', (store, _transaction, setResult) => {
    request = store.getAll();
    request.onsuccess = () => setResult(request.result);
  }, {
    ...options,
    errorCode: 'READ_FAILED',
    errorMessage: '履歴を読み込めませんでした',
  });
  return records.sort((left, right) => right.timestamp - left.timestamp);
}

export async function getRecord(id, options = {}) {
  let request;
  return runTransaction('readonly', (store, _transaction, setResult) => {
    request = store.get(id);
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

export async function deleteRecord(id, options = {}) {
  return runTransaction('readwrite', (store) => {
    store.delete(id);
  }, {
    ...options,
    errorCode: 'DELETE_FAILED',
    errorMessage: '記録を削除できませんでした',
  });
}

export async function clearAllRecords(options = {}) {
  return runTransaction('readwrite', (store) => {
    store.clear();
  }, {
    ...options,
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
  return runTransaction('readwrite', (store) => {
    const keys = [];
    store.clear();
    records.forEach((record) => {
      const request = store.put({ ...record });
      request.onsuccess = () => keys.push(request.result);
    });
    return keys;
  }, {
    ...options,
    errorCode: 'REPLACE_FAILED',
    errorMessage: '履歴を置き換えられませんでした',
  });
}
