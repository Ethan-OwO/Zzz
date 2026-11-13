// Own IndexedDB database, separate from 'zzz': adding a store needs a version
// bump, and M3 is bumping 'zzz' to version 2 in parallel.
import type { MotionEpoch, MotionSessionRecord } from './types.ts';

const DB_NAME = 'zzz-motion';
const DB_VERSION = 1;
type Store = 'sessions' | 'epochs';

let dbPromise: Promise<IDBDatabase> | null = null;

function openMotionDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      // Later versions add `if (oldVersion < 2)` blocks; never edit this one.
      if (event.oldVersion < 1) {
        db.createObjectStore('sessions', { keyPath: 'sessionId' });
        db.createObjectStore('epochs', { keyPath: ['sessionId', 'idx'] });
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

async function write(stores: Store[], fn: (tx: IDBTransaction) => void): Promise<void> {
  const db = await openMotionDb();
  await new Promise<void>((resolve, reject) => {
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

export function putMotionSession(s: MotionSessionRecord): Promise<void> {
  return write(['sessions'], (tx) => tx.objectStore('sessions').put(s));
}

/** All epochs in one transaction. */
export function putEpochs(list: MotionEpoch[]): Promise<void> {
  if (list.length === 0) return Promise.resolve();
  return write(['epochs'], (tx) => {
    const store = tx.objectStore('epochs');
    for (const e of list) store.put(e);
  });
}

export type MotionSessionData = MotionSessionRecord & { epochs: MotionEpoch[] };

/** Omitted sessionIds = every session. Sorted by startedAt; epochs by idx. */
export async function getMotionData(sessionIds?: string[]): Promise<MotionSessionData[]> {
  const db = await openMotionDb();
  const tx = db.transaction(['sessions', 'epochs'], 'readonly');
  // Both requests are issued before any await so the transaction stays alive.
  const [sessions, epochs] = await Promise.all([
    request(tx.objectStore('sessions').getAll() as IDBRequest<MotionSessionRecord[]>),
    request(tx.objectStore('epochs').getAll() as IDBRequest<MotionEpoch[]>),
  ]);
  const wanted = sessionIds ? sessions.filter((s) => sessionIds.includes(s.sessionId)) : sessions;
  const out: MotionSessionData[] = wanted.map((s) => ({
    ...s,
    // Compound keys sort by [sessionId, idx], so each session's epochs are already in idx order.
    epochs: epochs.filter((e) => e.sessionId === s.sessionId),
  }));
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

export function deleteMotionForSessions(sessionIds: string[]): Promise<void> {
  return write(['sessions', 'epochs'], (tx) => {
    for (const id of sessionIds) {
      tx.objectStore('sessions').delete(id);
      tx.objectStore('epochs').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]));
    }
  });
}

export function deleteAllMotion(): Promise<void> {
  return write(['sessions', 'epochs'], (tx) => {
    tx.objectStore('sessions').clear();
    tx.objectStore('epochs').clear();
  });
}
