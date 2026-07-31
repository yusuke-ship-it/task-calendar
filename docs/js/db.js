/**
 * IndexedDB ラッパー（第4章：アプリ内編集の保存先／オフライン対応）
 * 端末内に閉じる。第8章 E-1（端末間同期はしない割り切り）。
 */

const DB_NAME = 'notion-lifebear';
const DB_VERSION = 1;
const STORE_RECORDS = 'records';
const STORE_META = 'meta';

let _db = null;

export function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const s = db.createObjectStore(STORE_RECORDS, { keyPath: 'id' });
        s.createIndex('by_date', 'indexDate', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'k' });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror = () => reject(req.error);
  });
}

function tx(store, mode) {
  return openDB().then((db) => db.transaction(store, mode).objectStore(store));
}

const wrap = (req) =>
  new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

export async function getAllRecords() {
  return wrap((await tx(STORE_RECORDS, 'readonly')).getAll());
}

export async function getRecord(id) {
  return wrap((await tx(STORE_RECORDS, 'readonly')).get(id));
}

export async function putRecord(rec) {
  return wrap((await tx(STORE_RECORDS, 'readwrite')).put(rec));
}

export async function putRecords(recs) {
  if (!recs.length) return;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_RECORDS, 'readwrite');
    const s = t.objectStore(STORE_RECORDS);
    for (const r of recs) s.put(r);
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function deleteRecordHard(id) {
  return wrap((await tx(STORE_RECORDS, 'readwrite')).delete(id));
}

export async function getMeta(k, fallback = null) {
  const row = await wrap((await tx(STORE_META, 'readonly')).get(k));
  return row ? row.v : fallback;
}

export async function setMeta(k, v) {
  return wrap((await tx(STORE_META, 'readwrite')).put({ k, v }));
}

/** バックアップ用エクスポート（端末間同期をしない代わりの逃げ道・第8章） */
export async function exportAll() {
  return {
    exportedAt: new Date().toISOString(),
    records: await getAllRecords(),
    lastSync: await getMeta('lastSync'),
    projects: await getMeta('projects', {}),
  };
}

export async function importAll(payload) {
  if (!payload?.records) throw new Error('不正なバックアップファイルです');
  await putRecords(payload.records);
  if (payload.projects) await setMeta('projects', payload.projects);
  return payload.records.length;
}
