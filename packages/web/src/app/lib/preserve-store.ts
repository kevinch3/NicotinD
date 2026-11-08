/**
 * IndexedDB wrapper for preserved tracks — handles CRUD, LRU eviction, and storage budget.
 *
 * Three object stores:
 *   - `tracks`  — metadata (id, title, artist, credits, size, timestamps, source…)
 *   - `blobs`   — audio keyed by track id
 *   - `covers`  — one cover per album, keyed by `coverKeyOf` (#1658)
 *   - `lyrics`  — the song's stored lyrics row, keyed by track id (#1751)
 *
 * Schema versions:
 *   v1 — initial (tracks, blobs)
 *   v2 — cover thumbnails stored alongside audio
 *   v3 — `tracks.source: 'user' | 'auto'` distinguishes user-initiated preserves
 *         (saved via the track-row menu / collection buttons) from automatic
 *         queue-preserves (driven by the AutoPreserveCoordinator for PWA
 *         lock-screen resilience). Migration backfills every existing row
 *         with `source: 'user'` so eviction policy treats them as user-owned.
 *   v4 — `covers`: one cover per album, shared by every preserved track of it
 *         (#1658, owner decision). Keyed by `coverKeyOf(meta)`, the album that
 *         owns the cover's rev. The migration moves each v3 per-track cover into
 *         it (first one per album wins) and clears `blobs.cover`; a cover is
 *         deleted only with the last preserved track that points at it.
 *   v5 — `lyrics`: the stored `LyricsDto` per preserved track, so karaoke works
 *         offline (#1751). Written at preserve time and refreshed whenever the
 *         client reads the server's row; deleted with its track.
 */

const DB_NAME = 'nicotind-preserve';
import type { LyricsDto } from '@nicotind/core';
import { songCover } from './cover-url';

const DB_VERSION = 5;
const TRACKS_STORE = 'tracks';
const BLOBS_STORE = 'blobs';
const COVERS_STORE = 'covers';
const LYRICS_STORE = 'lyrics';

export const DEFAULT_BUDGET = 2 * 1024 * 1024 * 1024; // 2 GB

/** Where a preserve came from — drives the auto-first LRU eviction policy. */
export type PreserveSource = 'user' | 'auto';

export interface PreservedTrackMeta {
  id: string;
  title: string;
  artist: string;
  album: string;
  coverArt?: string;
  /** The album's cover rev and the album, as the track carried them (#1666). */
  coverRev?: number;
  albumId?: string;
  /** The primary artist and the credits with their ids (#1658), so artist links
   *  and joint credits survive offline. Absent on rows preserved before v4. */
  artistId?: string;
  artists?: Array<{ id: string; name: string; role: 'primary' | 'featuring' }>;
  genre?: string;
  duration?: number;
  bitRate?: number;
  size: number;
  format: string;
  preservedAt: number;
  lastAccessedAt: number;
  source: PreserveSource;
  /** 1 once the row carries everything a preserve stores today — credits,
   *  genre, the album cover, the lyrics (#1751). Rows saved before that are
   *  topped up once, the next time the app is online. */
  toppedUp?: 1;
}

/** Whether a preserved row predates the full record and wants a top-up (#1751). */
export function needsTopUp(meta: PreservedTrackMeta): boolean {
  return meta.toppedUp !== 1;
}

export interface PreservedBlob {
  id: string;
  audio: Blob;
  /** Always null since v4: the cover lives once per album in `covers`. */
  cover: Blob | null;
}

/** A preserved track's lyrics (#1751): the server's row as last read. */
export interface PreservedLyrics {
  id: string;
  dto: LyricsDto;
}

/** One album's preserved cover (#1658), served offline as an object URL. */
export interface PreservedCover {
  key: string;
  cover: Blob;
  coverArt?: string;
  coverRev: number;
}

/**
 * The `covers` key for a track's cover: the album that owns its rev — the same
 * owner `songCover` / `albumCover` name, so an album tile and its tracks find
 * one entry. Null for a track with no cover.
 */
export function coverKeyOf(meta: {
  coverArt?: string;
  coverRev?: number;
  albumId?: string;
}): string | null {
  const ref = songCover(meta);
  return ref ? `album:${ref.id}` : null;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const upgrade = req.transaction!;
      if (!db.objectStoreNames.contains(TRACKS_STORE)) {
        db.createObjectStore(TRACKS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(BLOBS_STORE)) {
        db.createObjectStore(BLOBS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(COVERS_STORE)) {
        db.createObjectStore(COVERS_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(LYRICS_STORE)) {
        db.createObjectStore(LYRICS_STORE, { keyPath: 'id' });
      }
      // v3: backfill source='user' on every existing track row. Old rows have
      // no field; writing them with the default keeps the eviction policy
      // conservative (they're treated as user-owned, never auto-evicted).
      const tracks = upgrade.objectStore(TRACKS_STORE);
      tracks.openCursor().onsuccess = (e) => {
        const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
        if (!cursor) return;
        const value = cursor.value as PreservedTrackMeta;
        if (value.source !== 'user' && value.source !== 'auto') {
          cursor.update({ ...value, source: 'user' });
        }
        cursor.continue();
      };
      // v4: move each per-track cover into the per-album `covers` store.
      if (event.oldVersion > 0 && event.oldVersion < 4) migrateCoversToAlbums(upgrade);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** v3 → v4: one cover per album, first per-track copy wins; `blobs.cover` cleared. */
function migrateCoversToAlbums(upgrade: IDBTransaction): void {
  const metas = upgrade.objectStore(TRACKS_STORE).getAll();
  metas.onsuccess = () => {
    const byId = new Map((metas.result as PreservedTrackMeta[]).map((m) => [m.id, m]));
    const covers = upgrade.objectStore(COVERS_STORE);
    const seen = new Set<string>();
    upgrade.objectStore(BLOBS_STORE).openCursor().onsuccess = (e) => {
      const cursor = (e.target as IDBRequest<IDBCursorWithValue | null>).result;
      if (!cursor) return;
      const blob = cursor.value as PreservedBlob;
      const meta = byId.get(blob.id);
      const key = meta ? coverKeyOf(meta) : null;
      if (blob.cover) {
        if (key && !seen.has(key)) {
          seen.add(key);
          covers.put({
            key,
            cover: blob.cover,
            coverArt: meta!.coverArt,
            coverRev: meta!.coverRev ?? 0,
          } satisfies PreservedCover);
        }
        cursor.update({ ...blob, cover: null });
      }
      cursor.continue();
    };
  };
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
  lyrics: LyricsDto | null = null,
): Promise<void> {
  const db = await open();
  const transaction = db.transaction(
    [TRACKS_STORE, BLOBS_STORE, COVERS_STORE, LYRICS_STORE],
    'readwrite',
  );
  transaction.objectStore(TRACKS_STORE).put(meta);
  transaction.objectStore(BLOBS_STORE).put({ id: meta.id, audio: audioBlob, cover: null });
  if (lyrics) {
    transaction
      .objectStore(LYRICS_STORE)
      .put({ id: meta.id, dto: lyrics } satisfies PreservedLyrics);
  }
  // One cover per album: the newest preserve's copy replaces the album's, so a
  // re-preserve after a cover change stores the current bytes.
  const key = coverKeyOf(meta);
  if (coverBlob && key) {
    transaction.objectStore(COVERS_STORE).put({
      key,
      cover: coverBlob,
      coverArt: meta.coverArt,
      coverRev: meta.coverRev ?? 0,
    } satisfies PreservedCover);
  }
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

export async function remove(id: string): Promise<void> {
  const db = await open();
  const transaction = db.transaction(
    [TRACKS_STORE, BLOBS_STORE, COVERS_STORE, LYRICS_STORE],
    'readwrite',
  );
  transaction.objectStore(LYRICS_STORE).delete(id);
  const tracks = transaction.objectStore(TRACKS_STORE);
  const get = tracks.get(id);
  get.onsuccess = () => {
    const key = get.result ? coverKeyOf(get.result as PreservedTrackMeta) : null;
    tracks.delete(id);
    transaction.objectStore(BLOBS_STORE).delete(id);
    if (!key) return;
    // A cover goes only with the last preserved track that points at it.
    const rest = tracks.getAll();
    rest.onsuccess = () => {
      const shared = (rest.result as PreservedTrackMeta[]).some((m) => coverKeyOf(m) === key);
      if (!shared) transaction.objectStore(COVERS_STORE).delete(key);
    };
  };
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

/** Every preserved album cover (#1658). */
export async function getAllCovers(): Promise<PreservedCover[]> {
  const db = await open();
  const result = await tx<PreservedCover[]>(db, COVERS_STORE, 'readonly', (t) =>
    t.objectStore(COVERS_STORE).getAll(),
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
  const transaction = db.transaction(
    [TRACKS_STORE, BLOBS_STORE, COVERS_STORE, LYRICS_STORE],
    'readwrite',
  );
  transaction.objectStore(LYRICS_STORE).clear();
  transaction.objectStore(TRACKS_STORE).clear();
  transaction.objectStore(BLOBS_STORE).clear();
  transaction.objectStore(COVERS_STORE).clear();
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

/** A preserved track's lyrics, or null when it has none stored (#1751). */
export async function getLyrics(id: string): Promise<LyricsDto | null> {
  const db = await open();
  const row = await tx<PreservedLyrics | undefined>(db, LYRICS_STORE, 'readonly', (t) =>
    t.objectStore(LYRICS_STORE).get(id),
  );
  db.close();
  return row?.dto ?? null;
}

/**
 * Keep a preserved track's lyrics current (#1751): store `dto` (or drop the
 * copy when the server holds none) — only while the track is preserved, so a
 * read for any other song writes nothing. Resolves whether it wrote.
 */
export async function refreshLyrics(id: string, dto: LyricsDto | null): Promise<boolean> {
  const db = await open();
  const transaction = db.transaction([TRACKS_STORE, LYRICS_STORE], 'readwrite');
  let wrote = false;
  const track = transaction.objectStore(TRACKS_STORE).getKey(id);
  track.onsuccess = () => {
    if (track.result === undefined) return;
    const lyrics = transaction.objectStore(LYRICS_STORE);
    if (dto) lyrics.put({ id, dto } satisfies PreservedLyrics);
    else lyrics.delete(id);
    wrote = true;
  };
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
  return wrote;
}

/**
 * Merge `patches` into the preserved rows they name (#1751 top-up). A row
 * removed meanwhile stays removed: only existing rows are written.
 */
export async function updateMetas(
  patches: Array<Partial<PreservedTrackMeta> & { id: string }>,
): Promise<void> {
  if (patches.length === 0) return;
  const db = await open();
  const transaction = db.transaction(TRACKS_STORE, 'readwrite');
  const tracks = transaction.objectStore(TRACKS_STORE);
  for (const patch of patches) {
    const get = tracks.get(patch.id);
    get.onsuccess = () => {
      if (get.result) tracks.put({ ...(get.result as PreservedTrackMeta), ...patch });
    };
  }
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  db.close();
}

/** Store an album's cover for preserved tracks that had none (#1751 top-up). */
export async function putCover(cover: PreservedCover): Promise<void> {
  const db = await open();
  await tx(db, COVERS_STORE, 'readwrite', (t) => t.objectStore(COVERS_STORE).put(cover));
  db.close();
}
