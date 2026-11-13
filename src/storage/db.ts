import type { HeartbeatRecord, MonitorEvent, SessionRecord } from '../monitor/types';

const DB_NAME = 'zzz';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

/** The only place in the project that calls indexedDB.open. */
export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // Later milestones bump DB_VERSION and add `if (oldVersion < 2)` blocks;
      // never edit the version 1 block.
      if (event.oldVersion < 1) {
        db.createObjectStore('sessions', { keyPath: 'id' });
        const hb = db.createObjectStore('heartbeats', { autoIncrement: true });
        hb.createIndex('bySession', 'sessionId');
        const ev = db.createObjectStore('events', { autoIncrement: true });
        ev.createIndex('bySession', 'sessionId');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error);
    };
    req.onblocked = () => {
      dbPromise = null;
      reject(new DOMException('indexedDB open blocked', 'InvalidStateError'));
    };
  });
  return dbPromise;
}

type StoreName = 'sessions' | 'heartbeats' | 'events';

async function write(stores: StoreName[], fn: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    // durability is ignored by browsers that do not support it.
    const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
    fn(tx);
  });
}

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** 新增或覆蓋。 */
export function putSession(s: SessionRecord): Promise<void> {
  return write(['sessions'], (tx) => tx.objectStore('sessions').put(s));
}

export function addHeartbeat(h: HeartbeatRecord): Promise<void> {
  return write(['heartbeats'], (tx) => tx.objectStore('heartbeats').add(h));
}

export function addEvent(e: MonitorEvent): Promise<void> {
  return write(['events'], (tx) => tx.objectStore('events').add(e));
}

/** Writes several events in one transaction (used to flush queued events). */
export function addEvents(list: MonitorEvent[]): Promise<void> {
  return write(['events'], (tx) => {
    const store = tx.objectStore('events');
    for (const e of list) store.add(e);
  });
}

/** 依 startedAt 由舊到新。 */
export async function listSessions(): Promise<SessionRecord[]> {
  const db = await openDb();
  const tx = db.transaction('sessions', 'readonly');
  const all = await request(tx.objectStore('sessions').getAll() as IDBRequest<SessionRecord[]>);
  return all.sort((a, b) => a.startedAt - b.startedAt);
}

export async function getSessionData(id: string): Promise<{ heartbeats: HeartbeatRecord[]; events: MonitorEvent[] }> {
  const db = await openDb();
  const tx = db.transaction(['heartbeats', 'events'], 'readonly');
  // autoIncrement keys follow insertion order, which is chronological.
  const [heartbeats, events] = await Promise.all([
    request(tx.objectStore('heartbeats').index('bySession').getAll(id) as IDBRequest<HeartbeatRecord[]>),
    request(tx.objectStore('events').index('bySession').getAll(id) as IDBRequest<MonitorEvent[]>),
  ]);
  return { heartbeats, events };
}

export function deleteAll(): Promise<void> {
  return write(['sessions', 'heartbeats', 'events'], (tx) => {
    tx.objectStore('sessions').clear();
    tx.objectStore('heartbeats').clear();
    tx.objectStore('events').clear();
  });
}
