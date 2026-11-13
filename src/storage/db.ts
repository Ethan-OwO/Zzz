import type {
  AudioChunkRecord, HeartbeatRecord, MonitorEvent, NightRecord, SessionRecord, SnoreEpisodeRecord, SoundEventRecord,
} from '../monitor/types';

const DB_NAME = 'zzz';
const DB_VERSION = 2;

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
      if (event.oldVersion < 2) {
        // M3. M2 test records are kept: the user may not have downloaded them yet.
        db.createObjectStore('nights', { keyPath: 'id' });
        const se = db.createObjectStore('soundEvents', { keyPath: 'id' });
        se.createIndex('byNight', 'nightId');
        db.createObjectStore('chunks', { keyPath: ['eventId', 'seq'] });
        const sn = db.createObjectStore('snoreEpisodes', { keyPath: 'id' });
        sn.createIndex('byNight', 'nightId');
        req.transaction!.objectStore('sessions').createIndex('byNight', 'nightId');
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

type StoreName = 'sessions' | 'heartbeats' | 'events' | 'nights' | 'soundEvents' | 'chunks' | 'snoreEpisodes';

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

// ---------- M3 ----------

export function putNight(n: NightRecord): Promise<void> {
  return write(['nights'], (tx) => tx.objectStore('nights').put(n));
}

export async function getNight(id: string): Promise<NightRecord | null> {
  const db = await openDb();
  const tx = db.transaction('nights', 'readonly');
  const n = await request(tx.objectStore('nights').get(id) as IDBRequest<NightRecord | undefined>);
  return n ?? null;
}

/** 依 startedAt 由舊到新。 */
export async function listNights(): Promise<NightRecord[]> {
  const db = await openDb();
  const tx = db.transaction('nights', 'readonly');
  const all = await request(tx.objectStore('nights').getAll() as IDBRequest<NightRecord[]>);
  return all.sort((a, b) => a.startedAt - b.startedAt);
}

export function putSoundEvent(e: SoundEventRecord): Promise<void> {
  return write(['soundEvents'], (tx) => tx.objectStore('soundEvents').put(e));
}

export function putSoundEvents(list: SoundEventRecord[]): Promise<void> {
  return write(['soundEvents'], (tx) => {
    const store = tx.objectStore('soundEvents');
    for (const e of list) store.put(e);
  });
}

export function addChunk(c: AudioChunkRecord): Promise<void> {
  return write(['chunks'], (tx) => tx.objectStore('chunks').add(c));
}

/** One transaction: the chunk, the event's new sampleCount and the night's audioSecUsed. */
export function saveChunk(c: AudioChunkRecord, e: SoundEventRecord, n: NightRecord): Promise<void> {
  return write(['chunks', 'soundEvents', 'nights'], (tx) => {
    tx.objectStore('chunks').put(c);
    tx.objectStore('soundEvents').put(e);
    tx.objectStore('nights').put(n);
  });
}

export function putSnoreEpisode(s: SnoreEpisodeRecord): Promise<void> {
  return write(['snoreEpisodes'], (tx) => tx.objectStore('snoreEpisodes').put(s));
}

export async function getNightData(nightId: string): Promise<{
  sessions: SessionRecord[]; soundEvents: SoundEventRecord[]; snoreEpisodes: SnoreEpisodeRecord[];
}> {
  const db = await openDb();
  const tx = db.transaction(['sessions', 'soundEvents', 'snoreEpisodes'], 'readonly');
  const [sessions, soundEvents, snoreEpisodes] = await Promise.all([
    request(tx.objectStore('sessions').index('byNight').getAll(nightId) as IDBRequest<SessionRecord[]>),
    request(tx.objectStore('soundEvents').index('byNight').getAll(nightId) as IDBRequest<SoundEventRecord[]>),
    request(tx.objectStore('snoreEpisodes').index('byNight').getAll(nightId) as IDBRequest<SnoreEpisodeRecord[]>),
  ]);
  sessions.sort((a, b) => a.startedAt - b.startedAt);
  soundEvents.sort((a, b) => a.startAt - b.startAt);
  snoreEpisodes.sort((a, b) => a.startAt - b.startAt);
  return { sessions, soundEvents, snoreEpisodes };
}

/** All chunks of [eventId, *] in key order. */
function chunkRange(eventId: string): IDBKeyRange {
  // Arrays sort after numbers, so [eventId, []] is above every [eventId, seq].
  return IDBKeyRange.bound([eventId], [eventId, []]);
}

/** 依 seq 串接。 */
export async function readEventAudio(eventId: string): Promise<Int16Array> {
  const db = await openDb();
  const tx = db.transaction('chunks', 'readonly');
  const chunks = await request(tx.objectStore('chunks').getAll(chunkRange(eventId)) as IDBRequest<AudioChunkRecord[]>);
  const total = chunks.reduce((n, c) => n + c.pcm.byteLength / 2, 0);
  const out = new Int16Array(total);
  let o = 0;
  for (const c of chunks) {
    const part = new Int16Array(c.pcm);
    out.set(part, o);
    o += part.length;
  }
  return out;
}

/** Deletes an event's chunks and saves the event (hasAudio false) and the night in one transaction. */
export function dropEventAudio(e: SoundEventRecord, n: NightRecord): Promise<void> {
  return write(['chunks', 'soundEvents', 'nights'], (tx) => {
    tx.objectStore('chunks').delete(chunkRange(e.id));
    tx.objectStore('soundEvents').put(e);
    tx.objectStore('nights').put(n);
  });
}

/** Deletes sessions (with their heartbeats and events) inside an open transaction. */
function deleteSessionsIn(tx: IDBTransaction, sessionIds: IDBValidKey[]): void {
  const sessions = tx.objectStore('sessions');
  for (const id of sessionIds) {
    sessions.delete(id);
    for (const name of ['heartbeats', 'events'] as const) {
      const idx = tx.objectStore(name).index('bySession');
      const r = idx.getAllKeys(id);
      r.onsuccess = () => {
        const store = tx.objectStore(name);
        for (const k of r.result) store.delete(k);
      };
    }
  }
}

/** 刪這一晚的 nights / sessions / heartbeats / events / soundEvents / chunks / snoreEpisodes。 */
export async function deleteNight(nightId: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const stores: StoreName[] = ['nights', 'sessions', 'heartbeats', 'events', 'soundEvents', 'chunks', 'snoreEpisodes'];
    const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new DOMException('transaction aborted', 'AbortError'));
    tx.objectStore('nights').delete(nightId);
    const sr = tx.objectStore('sessions').index('byNight').getAllKeys(nightId);
    sr.onsuccess = () => deleteSessionsIn(tx, sr.result);
    const er = tx.objectStore('soundEvents').index('byNight').getAllKeys(nightId);
    er.onsuccess = () => {
      for (const id of er.result) {
        tx.objectStore('soundEvents').delete(id);
        tx.objectStore('chunks').delete(chunkRange(String(id)));
      }
    };
    const nr = tx.objectStore('snoreEpisodes').index('byNight').getAllKeys(nightId);
    nr.onsuccess = () => {
      for (const id of nr.result) tx.objectStore('snoreEpisodes').delete(id);
    };
  });
}

/** nightId 為空的 M2 測試紀錄。 */
export async function listLegacySessions(): Promise<SessionRecord[]> {
  return (await listSessions()).filter((s) => !s.nightId);
}

export async function deleteLegacySessions(): Promise<void> {
  const ids = (await listLegacySessions()).map((s) => s.id);
  if (ids.length === 0) return;
  await write(['sessions', 'heartbeats', 'events'], (tx) => deleteSessionsIn(tx, ids));
}

/** Latest heartbeat time of a session, or null when it has none. */
export async function lastHeartbeatAt(sessionId: string): Promise<number | null> {
  const { heartbeats } = await getSessionData(sessionId);
  let t: number | null = null;
  for (const h of heartbeats) if (t === null || h.t > t) t = h.t;
  return t;
}
