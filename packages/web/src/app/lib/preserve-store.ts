/**
 * IndexedDB wrapper for preserved tracks — handles CRUD, LRU eviction, and storage budget.
 *
 * Two object stores:
 *   - `tracks`  — metadata (id, title, artist, size, timestamps, source…)
 *   - `blobs`   — audio + cover binary data keyed by track id
 *
 * Schema versions:
 *   v1 — initial (tracks, blobs)
 *   v2 — cover thumbnails stored alongside audio
 *   v3 — `tracks.source: 'user' | 'auto'` distinguishes user-initiated preserves
 *         (saved via the track-row menu / collection buttons) from automatic
 *         queue-preserves (driven by the AutoPreserveCoordinator for PWA
 *         lock-screen resilience). Migration backfills every existing row
 *         with `source: 'user'` so eviction policy treats them as user-owned.
 */

const DB_NAME = 'nicotind-preserve';
const DB_VERSION = 3;
const TRACKS_STORE = 'tracks';
const BLOBS_STORE = 'blobs';

export const DEFAULT_BUDGET = 2 * 1024 * 1024 * 1024; // 2 GB

/** Where a preserve came from — drives the auto-first LRU eviction policy. */
export type PreserveSource = 'user' | 'auto';

export interface PreservedTrackMeta {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverArt?: string;
  duration?: number;
  bitRate?: number;
  size: number;
  format: string;
  preservedAt: number;
  lastAccessedAt: number;
  source: PreserveSource;
}

export interface PreservedBlob {
  id: string;
  audio: Blob;
  cover: Blob | null;
}

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
      // v3: backfill source='user' on every existing track row. Old rows have
      // no field; writing them with the default keeps the eviction policy
      // conservative (they're treated as user-owned, never auto-evicted).
      if (db.objectStoreNames.contains(TRACKS_STORE)) {
        const tx = req.transaction!;
        const store = tx.objectStore(TRACKS_STORE);
        store.openCursor().onsuccess = (e) => {
          const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
          if (!cursor) return;
          const value = cursor.value as PreservedTrackMeta;
          if (value.source !== 'user' && value.source !== 'auto') {
            cursor.update({ ...value, source: 'user' });
          }
          cursor.continue();
        };
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
  const result = await tx<PreservedTrackMeta | undefined>(db, TRACKS_STORE, 'readonly', (t) =>
    t.objectStore(TRACKS_STORE).get(id),
  );
  db.close();
  return result;
}

export async function getBlob(id: string): Promise<PreservedBlob | undefined> {
  const db = await open();
  const result = await tx<PreservedBlob | undefined>(db, BLOBS_STORE, 'readonly', (t) =>
    t.objectStore(BLOBS_STORE).get(id),
  );
  db.close();
  return result;
}

export async function getAll(): Promise<PreservedTrackMeta[]> {
  const db = await open();
  const result = await tx<PreservedTrackMeta[]>(db, TRACKS_STORE, 'readonly', (t) =>
    t.objectStore(TRACKS_STORE).getAll(),
  );
  db.close();
  return result;
}

export async function getAutoPreserved(): Promise<PreservedTrackMeta[]> {
  const all = await getAll();
  return all.filter((t) => t.source === 'auto');
}

export async function updateLastAccessed(id: string): Promise<void> {
  const db = await open();
  const meta = await tx<PreservedTrackMeta | undefined>(db, TRACKS_STORE, 'readonly', (t) =>
    t.objectStore(TRACKS_STORE).get(id),
  );
  if (meta) {
    meta.lastAccessedAt = Date.now();
    await tx(db, TRACKS_STORE, 'readwrite', (t) => t.objectStore(TRACKS_STORE).put(meta));
  }
  db.close();
}

/**
 * Evict least-recently-played `source === 'auto'` rows until `bytesNeeded` is
 * free (or the budget cap is met). Never touches user-owned tracks. Used by
 * the auto-preserve path before each save so radio churn can't evict the
 * user's intentional offline collection.
 */
export async function evictAutoLRU(bytesNeeded: number, budget: number): Promise<string[]> {
  const all = await getAll();
  const auto = all.filter((t) => t.source === 'auto');
  const autoUsage = auto.reduce((sum, t) => sum + t.size, 0);
  const userUsage = all.reduce((sum, t) => sum + t.size, 0) - autoUsage;
  // Projected usage if we add `bytesNeeded` of new auto content.
  const projected = userUsage + autoUsage + bytesNeeded;
  if (projected <= budget) return [];

  // We need to free `target` bytes from auto rows (so the new row fits under cap).
  const target = projected - budget;
  const sorted = [...auto].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  let freed = 0;
  const evicted: string[] = [];

  for (const track of sorted) {
    if (freed >= target) break;
    await remove(track.id);
    freed += track.size;
    evicted.push(track.id);
  }

  return evicted;
}

/**
 * Mixed-source LRU eviction. Preferentially evicts auto rows first; if that
 * doesn't free enough, falls through to user rows. Used by single-track user
 * preserves and the toggle-off removeAllAutoPreserved path when budget is
 * tight.
 */
export async function evictLRU(bytesNeeded: number, budget: number): Promise<string[]> {
  const all = await getAll();
  const currentUsage = all.reduce((sum, t) => sum + t.size, 0);
  if (currentUsage + bytesNeeded <= budget) return [];

  const target = currentUsage + bytesNeeded - budget;
  // Auto first (cheap to lose), then user (only if auto exhausted).
  const autoSorted = [...all]
    .filter((t) => t.source === 'auto')
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
  const userSorted = [...all]
    .filter((t) => t.source === 'user')
    .sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

  let freed = 0;
  const evicted: string[] = [];

  for (const track of [...autoSorted, ...userSorted]) {
    if (freed >= target) break;
    await remove(track.id);
    freed += track.size;
    evicted.push(track.id);
  }

  return evicted;
}

/** Remove every `source === 'auto'` row. Returns the count removed. */
export async function removeAllAutoPreserved(): Promise<number> {
  const auto = await getAutoPreserved();
  for (const t of auto) await remove(t.id);
  return auto.length;
}

export async function clearAll(): Promise<void> {
  const db = await open();
  const transaction = db.transaction([TRACKS_STORE, BLOBS_STORE], 'readwrite');
  transaction.objectStore(TRACKS_STORE).clear();
  transaction.objectStore(BLOBS_STORE).clear();
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}