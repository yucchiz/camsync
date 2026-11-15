import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHMENT_BLOB_STORE_NAME,
  ATTACHMENT_STORE_NAME,
  DB_NAME,
  DB_VERSION,
  STORE_NAME,
  StorageError,
  addAttachment,
  addRecord,
  bulkAddRecords,
  clearAllRecords,
  createDeferredRecordDeleter,
  deleteAttachment,
  deleteRecord,
  getAllRecords,
  getAttachment,
  listAllAttachments,
  listAttachments,
  openDB,
  replaceAllRecords,
  upgradeSchema,
} from '../lib/storage.mjs';

// ---------------------------------------------------------------------------
// テスト用の最小 IndexedDB フェイク。ストレージ層が使う API だけを模倣する。
// リクエストはマイクロタスクで完了し、未完了リクエストがなくなった次のタスクで
// トランザクションが complete になる。abort 時は開始時点の内容へ戻す。
// ---------------------------------------------------------------------------

function domError(name) {
  const err = new Error(name);
  err.name = name;
  return err;
}

function keyMatches(query, key) {
  return query === undefined || query === null || query === key;
}

class FakeTransaction {
  constructor(db, names, mode) {
    this.db = db;
    this.names = names;
    this.mode = mode;
    this.pending = 0;
    this.finished = false;
    this.error = null;
    this.snapshot = new Map(names.map((name) => [name, db.data.stores.get(name).snapshot()]));
    this.scheduleCompletion();
  }

  objectStore(name) {
    if (!this.names.includes(name)) throw domError('NotFoundError');
    return new FakeStoreHandle(this, this.db.data.stores.get(name));
  }

  request(operation) {
    if (this.finished) throw domError('TransactionInactiveError');
    if (this.mode === 'readonly' && operation.write) throw domError('ReadOnlyError');
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending += 1;
    queueMicrotask(() => {
      if (this.finished) return;
      try {
        request.result = operation.run();
        request.onsuccess?.({ target: request });
      } catch (err) {
        request.error = err;
        this.error = err;
        request.onerror?.({ target: request });
        this.abort();
      } finally {
        this.pending -= 1;
        this.scheduleCompletion();
      }
    });
    return request;
  }

  scheduleCompletion() {
    setTimeout(() => {
      if (this.finished || this.pending > 0) return;
      this.finished = true;
      this.oncomplete?.();
    }, 0);
  }

  abort() {
    if (this.finished) throw domError('InvalidStateError');
    this.finished = true;
    this.snapshot.forEach((rows, name) => this.db.data.stores.get(name).restore(rows));
    setTimeout(() => this.onabort?.(), 0);
  }
}

class FakeStoreData {
  constructor({ keyPath, autoIncrement = false }) {
    this.keyPath = keyPath;
    this.autoIncrement = autoIncrement;
    this.nextKey = 1;
    this.rows = new Map();
    this.indexes = new Map();
  }

  snapshot() {
    return { rows: new Map(this.rows), nextKey: this.nextKey };
  }

  restore({ rows, nextKey }) {
    this.rows = rows;
    this.nextKey = nextKey;
  }

  sortedValues() {
    return [...this.rows.entries()].sort(([a], [b]) => a - b).map(([, value]) => value);
  }
}

class FakeStoreHandle {
  constructor(transaction, data) {
    this.transaction = transaction;
    this.data = data;
  }

  createIndex(name, keyPath) {
    this.data.indexes.set(name, keyPath);
  }

  write(value, { overwrite }) {
    const data = this.data;
    // 容量不足などの書き込み失敗を再現するためのフック。
    if (data.failWritesWith) throw domError(data.failWritesWith);
    const copy = { ...value };
    let key = copy[data.keyPath];
    if (key === undefined && data.autoIncrement) {
      key = data.nextKey;
      copy[data.keyPath] = key;
    }
    if (key === undefined) throw domError('DataError');
    if (!overwrite && data.rows.has(key)) throw domError('ConstraintError');
    if (typeof key === 'number' && key >= data.nextKey) data.nextKey = Math.floor(key) + 1;
    data.rows.set(key, copy);
    return key;
  }

  add(value) {
    return this.transaction.request({ write: true, run: () => this.write(value, { overwrite: false }) });
  }

  put(value) {
    return this.transaction.request({ write: true, run: () => this.write(value, { overwrite: true }) });
  }

  get(key) {
    return this.transaction.request({ run: () => this.data.rows.get(key) });
  }

  getAll() {
    return this.transaction.request({ run: () => this.data.sortedValues() });
  }

  delete(key) {
    return this.transaction.request({ write: true, run: () => { this.data.rows.delete(key); } });
  }

  clear() {
    return this.transaction.request({ write: true, run: () => { this.data.rows.clear(); } });
  }

  index(name) {
    const keyPath = this.data.indexes.get(name);
    if (!keyPath) throw domError('NotFoundError');
    const matches = (query) => this.data.sortedValues().filter((value) => keyMatches(query, value[keyPath]));
    return {
      getAll: (query) => this.transaction.request({ run: () => matches(query) }),
      getAllKeys: (query) => this.transaction.request({
        run: () => matches(query).map((value) => value[this.data.keyPath]),
      }),
      count: (query) => this.transaction.request({ run: () => matches(query).length }),
    };
  }
}

class FakeConnection {
  constructor(data) {
    this.data = data;
    this.closed = false;
    this.onversionchange = null;
    this.objectStoreNames = { contains: (name) => data.stores.has(name) };
  }

  createObjectStore(name, options) {
    const store = new FakeStoreData(options);
    this.data.stores.set(name, store);
    return new FakeStoreHandle(this.upgradeTransaction, store);
  }

  transaction(names, mode = 'readonly') {
    if (this.closed) throw domError('InvalidStateError');
    const list = Array.isArray(names) ? names : [names];
    list.forEach((name) => {
      if (!this.data.stores.has(name)) throw domError('NotFoundError');
    });
    return new FakeTransaction(this, list, mode);
  }

  close() {
    this.closed = true;
  }
}

function createFakeIndexedDB() {
  const databases = new Map();
  const opened = [];
  return {
    databases,
    opened,
    open(name, version) {
      const request = { result: undefined, error: null, transaction: null };
      setTimeout(() => {
        const data = databases.get(name) ?? { version: 0, stores: new Map() };
        if (version < data.version) {
          request.error = domError('VersionError');
          request.onerror?.();
          return;
        }
        const connection = new FakeConnection(data);
        opened.push(connection);
        request.result = connection;
        if (version > data.version) {
          const oldVersion = data.version;
          connection.upgradeTransaction = { objectStore: () => null };
          request.transaction = connection.upgradeTransaction;
          request.onupgradeneeded?.({ target: request, oldVersion, newVersion: version });
          data.version = version;
          databases.set(name, data);
          request.transaction = null;
        }
        request.onsuccess?.();
      }, 0);
      return request;
    },
  };
}

function seedVersion1(factory, records) {
  const store = new FakeStoreData({ keyPath: 'id', autoIncrement: true });
  store.indexes.set('timestamp', 'timestamp');
  records.forEach((record) => {
    store.rows.set(record.id, { ...record });
    store.nextKey = Math.max(store.nextKey, record.id + 1);
  });
  factory.databases.set(DB_NAME, { version: 1, stores: new Map([[STORE_NAME, store]]) });
}

function sampleRecord(timestamp = 1_700_000_000_000) {
  return { timestamp, refTime: '2024/01/01 10:00:00', camTime: '2024/01/01 10:00:05' };
}

function sampleAttachment(overrides = {}) {
  const blob = new Blob([Uint8Array.from([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' });
  return { name: 'camera.png', mime: 'image/png', size: blob.size, blob, ...overrides };
}

// ---------------------------------------------------------------------------

test('既存IndexedDB契約を維持し、添付用にバージョン2へ上げる', () => {
  assert.equal(DB_NAME, 'CamSyncDB');
  assert.equal(DB_VERSION, 2);
  assert.equal(STORE_NAME, 'records');
  assert.equal(ATTACHMENT_STORE_NAME, 'attachments');
  assert.equal(ATTACHMENT_BLOB_STORE_NAME, 'attachmentBlobs');
});

test('IndexedDBを利用できない場合は構造化エラーを返す', async () => {
  await assert.rejects(
    openDB({ indexedDBFactory: {} }),
    (error) => error instanceof StorageError && error.code === 'UNAVAILABLE',
  );
});

test('一括処理はtransaction開始前に入力配列を検証する', async () => {
  await assert.rejects(bulkAddRecords(null), TypeError);
  await assert.rejects(replaceAllRecords([null]), TypeError);
});

test('upgradeSchemaは新規作成時に全ストアを作る', () => {
  const created = [];
  const db = {
    objectStoreNames: { contains: () => false },
    createObjectStore(name, options) {
      const indexes = [];
      created.push({ name, options, indexes });
      return { createIndex: (indexName, keyPath, opts) => indexes.push({ indexName, keyPath, opts }) };
    },
    deleteObjectStore() {
      throw new Error('既存ストアを削除してはいけません');
    },
  };
  upgradeSchema(db);

  assert.deepEqual(created.map((item) => item.name), [STORE_NAME, ATTACHMENT_STORE_NAME, ATTACHMENT_BLOB_STORE_NAME]);
  assert.deepEqual(created[0].options, { keyPath: 'id', autoIncrement: true });
  assert.deepEqual(created[0].indexes, [{ indexName: 'timestamp', keyPath: 'timestamp', opts: { unique: false } }]);
  assert.deepEqual(created[1].options, { keyPath: 'id', autoIncrement: true });
  assert.deepEqual(created[1].indexes, [{ indexName: 'recordId', keyPath: 'recordId', opts: { unique: false } }]);
  assert.deepEqual(created[2].options, { keyPath: 'id' });
});

test('upgradeSchemaはバージョン1からrecordsに触れず添付ストアだけを追加する', () => {
  const existing = new Set([STORE_NAME]);
  const created = [];
  const db = {
    objectStoreNames: { contains: (name) => existing.has(name) },
    createObjectStore(name) {
      created.push(name);
      existing.add(name);
      return { createIndex() {} };
    },
    deleteObjectStore() {
      throw new Error('既存ストアを削除してはいけません');
    },
  };
  upgradeSchema(db);
  assert.deepEqual(created, [ATTACHMENT_STORE_NAME, ATTACHMENT_BLOB_STORE_NAME]);

  created.length = 0;
  upgradeSchema(db);
  assert.deepEqual(created, []);
});

test('バージョン1のデータベースを開くと既存の記録を保ったまま添付を使える', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  seedVersion1(indexedDBFactory, [{ id: 3, ...sampleRecord() }]);

  const records = await getAllRecords({ indexedDBFactory });
  assert.deepEqual(records, [{ id: 3, ...sampleRecord() }]);
  assert.equal(indexedDBFactory.databases.get(DB_NAME).version, 2);

  const meta = await addAttachment(3, sampleAttachment(), { indexedDBFactory, now: 42 });
  assert.deepEqual(meta, { id: 1, recordId: 3, name: 'camera.png', mime: 'image/png', size: 4, createdAt: 42 });
  assert.ok(indexedDBFactory.opened.every((connection) => connection.closed));
});

test('添付の追加・一覧・取得・削除', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const first = await addRecord(sampleRecord(1), options);
  const second = await addRecord(sampleRecord(2), options);

  const a = await addAttachment(first, sampleAttachment({ name: 'a.png' }), { ...options, now: 10 });
  const b = await addAttachment(first, sampleAttachment({ name: 'b.png' }), { ...options, now: 20 });
  const c = await addAttachment(second, sampleAttachment({ name: 'c.png' }), { ...options, now: 30 });

  const listed = await listAttachments(first, options);
  assert.deepEqual(listed.map((item) => item.name), ['a.png', 'b.png']);
  assert.ok(listed.every((item) => !('blob' in item)), '一覧はBlob本体を含まない');

  const all = await listAllAttachments(options);
  assert.deepEqual(all.map((item) => [item.recordId, item.name]), [[first, 'a.png'], [first, 'b.png'], [second, 'c.png']]);

  const loaded = await getAttachment(b.id, options);
  assert.equal(loaded.name, 'b.png');
  assert.equal(loaded.recordId, first);
  assert.ok(loaded.blob instanceof Blob);
  assert.equal(await getAttachment(999, options), null);

  await deleteAttachment(a.id, options);
  assert.deepEqual((await listAttachments(first, options)).map((item) => item.id), [b.id]);
  assert.equal(await getAttachment(a.id, options), null);
  const blobStore = indexedDBFactory.databases.get(DB_NAME).stores.get(ATTACHMENT_BLOB_STORE_NAME);
  assert.deepEqual([...blobStore.rows.keys()], [b.id, c.id]);
});

test('存在しない記録には添付できない', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  await assert.rejects(
    addAttachment(1, sampleAttachment(), { indexedDBFactory }),
    (error) => error instanceof StorageError && error.code === 'NOT_FOUND',
  );
  const stores = indexedDBFactory.databases.get(DB_NAME).stores;
  assert.equal(stores.get(ATTACHMENT_STORE_NAME).rows.size, 0);
  assert.equal(stores.get(ATTACHMENT_BLOB_STORE_NAME).rows.size, 0);
});

test('1記録あたりの件数上限をトランザクション内で検査する', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const id = await addRecord(sampleRecord(), options);
  for (let index = 0; index < 10; index += 1) {
    await addAttachment(id, sampleAttachment(), options);
  }
  await assert.rejects(
    addAttachment(id, sampleAttachment(), options),
    (error) => error instanceof StorageError && error.code === 'ATTACHMENT_LIMIT_REACHED',
  );
  assert.equal((await listAttachments(id, options)).length, 10);
});

test('addAttachmentは許可リスト外や不整合な添付を拒否する', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const id = await addRecord(sampleRecord(), options);
  await assert.rejects(addAttachment(id, sampleAttachment({ mime: 'image/svg+xml' }), options), TypeError);
  await assert.rejects(addAttachment(id, sampleAttachment({ size: 99 }), options), TypeError);
  await assert.rejects(addAttachment(id, sampleAttachment({ blob: 'data' }), options), TypeError);
  await assert.rejects(addAttachment(id, sampleAttachment({ name: '' }), options), TypeError);
  await assert.rejects(addAttachment(id, null, options), TypeError);
});

test('記録の削除で、その記録の添付だけを同じトランザクションで削除する', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const first = await addRecord(sampleRecord(1), options);
  const second = await addRecord(sampleRecord(2), options);
  await addAttachment(first, sampleAttachment(), options);
  await addAttachment(first, sampleAttachment(), options);
  const kept = await addAttachment(second, sampleAttachment(), options);

  await deleteRecord(first, options);

  assert.deepEqual((await getAllRecords(options)).map((record) => record.id), [second]);
  assert.deepEqual((await listAllAttachments(options)).map((item) => item.id), [kept.id]);
  const blobStore = indexedDBFactory.databases.get(DB_NAME).stores.get(ATTACHMENT_BLOB_STORE_NAME);
  assert.deepEqual([...blobStore.rows.keys()], [kept.id]);
});

test('全件削除と全件置換は添付を残さない', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const stores = () => indexedDBFactory.databases.get(DB_NAME).stores;

  const id = await addRecord(sampleRecord(), options);
  await addAttachment(id, sampleAttachment(), options);
  await clearAllRecords(options);
  assert.equal(stores().get(STORE_NAME).rows.size, 0);
  assert.equal(stores().get(ATTACHMENT_STORE_NAME).rows.size, 0);
  assert.equal(stores().get(ATTACHMENT_BLOB_STORE_NAME).rows.size, 0);

  const again = await addRecord(sampleRecord(), options);
  await addAttachment(again, sampleAttachment(), options);
  const keys = await replaceAllRecords([{ id: again, ...sampleRecord(5) }], options);
  assert.deepEqual(keys, [again]);
  assert.equal(stores().get(STORE_NAME).rows.size, 1);
  assert.equal(stores().get(ATTACHMENT_STORE_NAME).rows.size, 0);
  assert.equal(stores().get(ATTACHMENT_BLOB_STORE_NAME).rows.size, 0);
});

test('一括追加は既存の添付を維持する', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const id = await addRecord(sampleRecord(), options);
  await addAttachment(id, sampleAttachment(), options);
  const ids = await bulkAddRecords([sampleRecord(7), sampleRecord(8)], options);
  assert.equal(ids.length, 2);
  assert.equal((await listAttachments(id, options)).length, 1);
});

test('古いタブが接続を閉じない場合はBLOCKEDで理由を伝える', async () => {
  let request;
  const notified = [];
  const indexedDBFactory = {
    open() {
      request = {};
      setTimeout(() => request.onblocked?.({ oldVersion: 1, newVersion: 2 }), 0);
      return request;
    },
  };
  await assert.rejects(
    openDB({ indexedDBFactory, blockedTimeoutMs: 5, onBlocked: () => notified.push('blocked') }),
    (error) => error instanceof StorageError
      && error.code === 'BLOCKED'
      && /他のタブ/.test(error.message),
  );
  assert.deepEqual(notified, ['blocked']);

  // 後からアップグレードが成功しても、接続を開いたまま残さない。
  let closed = false;
  request.result = { close: () => { closed = true; } };
  request.onsuccess?.();
  assert.equal(closed, true);
});

test('ブロック後に古いタブが閉じれば通常どおり開ける', async () => {
  const connection = { close() {} };
  const indexedDBFactory = {
    open() {
      const request = {};
      setTimeout(() => request.onblocked?.({}), 0);
      setTimeout(() => {
        request.result = connection;
        request.onsuccess?.();
      }, 1);
      return request;
    },
  };
  const db = await openDB({ indexedDBFactory, blockedTimeoutMs: 1000 });
  assert.equal(db, connection);
});

test('新しいバージョンで作られたデータベースはVERSION_MISMATCHで理由を伝える', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  indexedDBFactory.databases.set(DB_NAME, { version: 99, stores: new Map() });
  await assert.rejects(
    openDB({ indexedDBFactory }),
    (error) => error instanceof StorageError
      && error.code === 'VERSION_MISMATCH'
      && /再読み込み/.test(error.message),
  );
});

test('他のタブがアップグレードを要求したら接続を閉じて通知する', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const notified = [];
  const db = await openDB({ indexedDBFactory, onVersionChange: () => notified.push('versionchange') });
  db.onversionchange();
  assert.equal(db.closed, true);
  assert.deepEqual(notified, ['versionchange']);
});

// ---------------------------------------------------------------------------
// 容量不足と、削除の取り消し猶予
// ---------------------------------------------------------------------------

test('保存容量の不足はQUOTA_EXCEEDEDとして区別する', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const id = await addRecord(sampleRecord(), options);
  const stores = indexedDBFactory.databases.get(DB_NAME).stores;

  stores.get(ATTACHMENT_STORE_NAME).failWritesWith = 'QuotaExceededError';
  await assert.rejects(
    addAttachment(id, sampleAttachment(), options),
    (error) => error instanceof StorageError
      && error.code === 'QUOTA_EXCEEDED'
      && /容量/.test(error.message)
      && error.cause?.name === 'QuotaExceededError',
  );
  assert.equal(stores.get(ATTACHMENT_STORE_NAME).rows.size, 0);

  stores.get(STORE_NAME).failWritesWith = 'QuotaExceededError';
  await assert.rejects(
    addRecord(sampleRecord(), options),
    (error) => error instanceof StorageError && error.code === 'QUOTA_EXCEEDED',
  );
});

function manualTimers() {
  const timers = new Map();
  let nextId = 1;
  return {
    timers,
    setTimer(callback, delay) {
      const id = nextId;
      nextId += 1;
      timers.set(id, { callback, delay });
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    runAll() {
      const pending = [...timers.values()];
      timers.clear();
      pending.forEach(({ callback }) => callback());
    },
  };
}

async function seedRecordWithAttachments(options) {
  const id = await addRecord(sampleRecord(1), options);
  const other = await addRecord(sampleRecord(2), options);
  await addAttachment(id, sampleAttachment({ name: 'a.png' }), options);
  await addAttachment(id, sampleAttachment({ name: 'b.png' }), options);
  await addAttachment(other, sampleAttachment({ name: 'c.png' }), options);
  return { id, other };
}

test('添付のある記録を削除して元に戻すと、記録のidと添付がすべて残る', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const { id } = await seedRecordWithAttachments(options);
  const timers = manualTimers();
  const deleter = createDeferredRecordDeleter({ ...options, delayMs: 6000, ...timers });

  deleter.schedule(id);
  assert.equal(deleter.isPending(id), true);
  assert.equal([...timers.timers.values()][0].delay, 6000);

  assert.equal(deleter.cancel(id), true);
  assert.equal(deleter.isPending(id), false);
  timers.runAll();
  await deleter.flush();

  assert.deepEqual((await getAllRecords(options)).map((record) => record.id).sort(), [1, 2]);
  const restored = await listAttachments(id, options);
  assert.deepEqual(restored.map((item) => item.name), ['a.png', 'b.png']);
  for (const item of restored) {
    const loaded = await getAttachment(item.id, options);
    assert.ok(loaded.blob instanceof Blob);
    assert.equal(loaded.blob.size, item.size);
  }
});

test('取り消し猶予が過ぎると、記録とその添付を確定削除する', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const { id, other } = await seedRecordWithAttachments(options);
  const timers = manualTimers();
  const deleter = createDeferredRecordDeleter({ ...options, delayMs: 10, ...timers });

  deleter.schedule(id);
  // 猶予中はデータベースから消さない（アプリを閉じても記録は残る）。
  assert.equal((await getAllRecords(options)).length, 2);
  assert.equal((await listAttachments(id, options)).length, 2);

  timers.runAll();
  await deleter.flush();
  assert.equal(deleter.isPending(id), false);
  assert.equal(deleter.cancel(id), false, '確定後は取り消せない');

  assert.deepEqual((await getAllRecords(options)).map((record) => record.id), [other]);
  assert.deepEqual((await listAllAttachments(options)).map((item) => item.recordId), [other]);
  const blobStore = indexedDBFactory.databases.get(DB_NAME).stores.get(ATTACHMENT_BLOB_STORE_NAME);
  assert.equal(blobStore.rows.size, 1);
});

test('flushは猶予中の削除をすぐに確定し、他の操作の前に整合を取れる', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const { id, other } = await seedRecordWithAttachments(options);
  const timers = manualTimers();
  const deleter = createDeferredRecordDeleter({ ...options, delayMs: 6000, ...timers });

  deleter.schedule(id);
  deleter.schedule(other);
  deleter.schedule(id);
  assert.equal(timers.timers.size, 2, '同じ記録の二重予約はしない');

  await deleter.flush();
  assert.equal(timers.timers.size, 0);
  assert.deepEqual(await getAllRecords(options), []);
  assert.deepEqual(await listAllAttachments(options), []);
});

test('確定削除の失敗は通知し、記録は残して取り消し済みとして扱う', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const { id } = await seedRecordWithAttachments(options);
  const timers = manualTimers();
  const failures = [];
  const deleter = createDeferredRecordDeleter({
    ...options,
    delayMs: 10,
    ...timers,
    deleteFn: async () => { throw new StorageError('DELETE_FAILED', '記録を削除できませんでした'); },
    onCommitError: (failedId, error) => failures.push([failedId, error.code]),
  });

  deleter.schedule(id);
  await deleter.flush();
  assert.deepEqual(failures, [[id, 'DELETE_FAILED']]);
  assert.equal(deleter.isPending(id), false);
  assert.equal((await listAttachments(id, options)).length, 2);
});

test('確定削除の実行中も猶予中として扱い、完了を待てる', async () => {
  let release;
  const calls = [];
  const deleter = createDeferredRecordDeleter({
    delayMs: 10,
    ...manualTimers(),
    deleteFn: (id) => {
      calls.push(id);
      return new Promise((resolve) => { release = resolve; });
    },
  });
  deleter.schedule(5);
  const flushing = deleter.flush();
  assert.equal(deleter.isPending(5), true, '削除完了までは履歴に再表示しない');
  assert.equal(deleter.cancel(5), false, '実行中は取り消せない');
  release();
  await flushing;
  assert.equal(deleter.isPending(5), false);
  assert.deepEqual(calls, [5]);
});

test('cancelAllは猶予中の削除をすべて取りやめ、実行中の削除は取りやめない', async () => {
  const indexedDBFactory = createFakeIndexedDB();
  const options = { indexedDBFactory };
  const { id, other } = await seedRecordWithAttachments(options);
  const timers = manualTimers();
  let release;
  const deleter = createDeferredRecordDeleter({
    delayMs: 6000,
    ...timers,
    deleteFn: () => new Promise((resolve) => { release = resolve; }),
  });

  assert.equal(deleter.hasCancellable(), false);
  deleter.schedule(id);
  deleter.schedule(other);
  assert.equal(deleter.hasCancellable(), true);
  assert.deepEqual(deleter.cancelAll().sort(), [id, other].sort());
  assert.equal(timers.timers.size, 0);
  assert.equal(deleter.isPending(id), false);
  assert.equal(deleter.hasCancellable(), false);
  assert.equal((await getAllRecords(options)).length, 2, '記録は残っている');

  deleter.schedule(id);
  const flushing = deleter.flush();
  assert.equal(deleter.hasCancellable(), false, '実行中の削除は取り消し対象ではない');
  assert.deepEqual(deleter.cancelAll(), []);
  release();
  await flushing;
});
