/**
 * IndexedDB wrapper for preserved tracks — handles CRUD, LRU eviction, and storage budget.
 *
 * Two object stores:
 *   - `tracks`  — metadata (id, title, artist, size, timestamps…)
 *   - `blobs`   — audio + cover binary data keyed by track id
 */

const DB_NAME = 'nicotind-preserve';
const DB_VERSION = 1;
const TRACKS_STORE = 'tracks';
const BLOBS_STORE = 'blobs';

export const DEFAULT_BUDGET = 2 * 1024 * 1024 * 1024; // 2 GB

export interface PreservedTrackMeta {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverArt?: string;
  duration?: number;
  size: number; // audio blob byte length
  format: string; // e.g. "audio/mpeg"
  preservedAt: number; // Date.now()
  lastAccessedAt: number; // updated on each play
}

export interface PreservedBlob {
  id: string;
  audio: Blob;
  cover: Blob | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);

    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(TRACKS_STORE)) {
        db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: 'id' });
      }
    };

    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(
  db: IDBDatabase,
  stores: string | string[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(stores, mode);
    const request = fn(transaction);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function preserve(
  meta: PreservedTrackMeta,
  audioBlob: Blob,
  coverBlob: Blob | null,
): Promise<void> {
  const db = await open();
  const transaction = db.transaction([TRACKS_STORE, BLOBS_STORE], 'readwrite');
  transaction.objectStore(TRACKS_STORE).put(meta);
  transaction.objectStore(BLOBS_STORE).put({ id: meta.id, audio: audioBlob, cover: coverBlob });
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function remove(id: string): Promise<void> {
  const db = await open();
  const transaction = db.transaction([TRACKS_STORE, BLOBS_STORE], 'readwrite');
  transaction.objectStore(TRACKS_STORE).delete(id);
  transaction.objectStore(BLOBS_STORE).delete(id);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function get(id: string): Promise<PreservedTrackMeta | undefined> {
  const db = await open();
  const result = await tx<PreservedTrackMeta | undefined>(
    db,
    TRACKS_STORE,
    'readonly',
    (t) => t.objectStore(TRACKS_STORE).get(id),
  );
  db.close();
  return result;
}

export async function getBlob(id: string): Promise<PreservedBlob | undefined> {
  const db = await open();
  const result = await tx<PreservedBlob | undefined>(
    db,
    BLOBS_STORE,
    'readonly',
    (t) => t.objectStore(BLOBS_STORE).get(id),
  );
  db.close();
  return result;
}

export async function getAll(): Promise<PreservedTrackMeta[]> {
  const db = await open();
  const result = await tx<PreservedTrackMeta[]>(
    db,
    TRACKS_STORE,
    'readonly',
    (t) => t.objectStore(TRACKS_STORE).getAll(),
  );
  db.close();
  return result;
}

export async function isPreserved(id: string): Promise<boolean> {
  const db = await open();
  const result = await tx<IDBValidKey | undefined>(
    db,
    TRACKS_STORE,
    'readonly',
    (t) => t.objectStore(TRACKS_STORE).getKey(id),
  );
  db.close();
  return result !== undefined;
}

export async function updateLastAccessed(id: string): Promise<void> {
  const db = await open();
  const meta = await tx<PreservedTrackMeta | undefined>(
    db,
    TRACKS_STORE,
    'readonly',
    (t) => t.objectStore(TRACKS_STORE).get(id),
  );
  if (meta) {
    meta.lastAccessedAt = Date.now();
    await tx(db, TRACKS_STORE, 'readwrite', (t) => t.objectStore(TRACKS_STORE).put(meta));
  }
  db.close();
}

export async function getUsage(): Promise<number> {
  const all = await getAll();
  return all.reduce((sum, t) => sum + t.size, 0);
}

/**
 * Evict oldest-accessed tracks until `bytesNeeded` can fit within `budget`.
 * Returns the IDs that were evicted.
 */
export async function evictLRU(bytesNeeded: number, budget: number): Promise<string[]> {
  const all = await getAll();
  const currentUsage = all.reduce((sum, t) => sum + t.size, 0);

  if (currentUsage + bytesNeeded <= budget) return [];

  // Sort oldest-accessed first
  const sorted = [...all].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

  let freed = 0;
  const target = currentUsage + bytesNeeded - budget;
  const evicted: string[] = [];

  for (const track of sorted) {
    if (freed >= target) break;
    await remove(track.id);
    freed += track.size;
    evicted.push(track.id);
  }

  return evicted;
}
