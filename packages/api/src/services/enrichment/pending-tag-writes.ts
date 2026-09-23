import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { FeatureTags } from '../audio-tags.js';
import { loadGenreSets } from '../genre-split.js';
import { resolveSongAbsPath } from '../track-backfill.js';
import { rebaseAnalysisFileSize } from './analysis-failures.js';

/**
 * Coalesced enrichment file-tag writes (#1311).
 *
 * Up to five enrichment tasks mirror their result into a new song's file. Each
 * write is a container rewrite (a picture round-trip on Opus), and each moves
 * the file's mtime + size — the transcode-cache key, the waveform-cache key and
 * the scanner's stat cache — so five writes meant five invalidations and five
 * re-parses. The DB write stays immediate; the file write is queued here and
 * flushed once per song, after the batch's tasks have settled.
 *
 * The queue stores field NAMES only. The flush re-reads every value from the
 * song row, so a curator edit landing between enqueue and flush is what gets
 * written — a stale derived value cannot overwrite it. Keyed by song id and
 * persisted, so a restart loses nothing and no song's flush can cancel another's.
 *
 * → docs/library-processing.md "Enrichment tag writes are coalesced per song"
 */

const log = createLogger('pending-tag-writes');

export type PendingTagField =
  | 'bpm'
  | 'key'
  | 'genre'
  | 'energy'
  | 'loudness'
  | 'danceability'
  | 'valence'
  | 'acousticness'
  | 'instrumental'
  | 'mood';

const COLUMN_FIELDS = [
  'bpm',
  'key',
  'energy',
  'loudness',
  'danceability',
  'valence',
  'acousticness',
  'instrumental',
  'mood',
] as const satisfies readonly PendingTagField[];

const ALL_FIELDS: ReadonlySet<string> = new Set<PendingTagField>([...COLUMN_FIELDS, 'genre']);

export type FlushTags = { bpm?: number; genre?: string; key?: string } & FeatureTags;

export interface FlushDeps {
  musicDir: string;
  writeTags: (abs: string, tags: FlushTags) => Promise<boolean>;
  fileExists: (abs: string) => boolean;
  fileSize?: (abs: string) => number | null;
}

export interface FlushResult {
  written: number;
  failed: number;
  /** Rows dropped with no write: the song is gone, or nothing is left to mirror. */
  dropped: number;
  /** Rows kept for the next flush because the song changed under the write. */
  retained: number;
}

function parseFields(raw: string): PendingTagField[] {
  return raw
    .split(',')
    .map((f) => f.trim())
    .filter((f): f is PendingTagField => ALL_FIELDS.has(f));
}

/** Queue `fields` for `songId`, merged with whatever is already pending for it. */
export function enqueueTagWrite(
  db: Database,
  songId: string,
  fields: readonly PendingTagField[],
  now: number = Date.now(),
): void {
  if (fields.length === 0) return;
  db.transaction(() => {
    const row = db
      .query<{ fields: string }, [string]>(
        'SELECT fields FROM library_pending_tag_writes WHERE song_id = ?',
      )
      .get(songId);
    const merged = new Set<PendingTagField>(row ? parseFields(row.fields) : []);
    for (const f of fields) merged.add(f);
    db.run(
      `INSERT INTO library_pending_tag_writes (song_id, fields, enqueued_at) VALUES (?, ?, ?)
       ON CONFLICT(song_id) DO UPDATE SET fields = excluded.fields,
         enqueued_at = MAX(excluded.enqueued_at, library_pending_tag_writes.enqueued_at + 1)`,
      [songId, [...merged].sort().join(','), now],
    );
  })();
}

export function countPendingTagWrites(db: Database): number {
  return (
    db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM library_pending_tag_writes').get()?.n ??
    0
  );
}

type SongValues = { path: string } & Partial<Record<(typeof COLUMN_FIELDS)[number], unknown>>;

/** The tags to write for `fields`, read from the song row as it is now. */
function currentTags(
  db: Database,
  songId: string,
  fields: PendingTagField[],
): { path: string; tags: FlushTags } | null {
  const row = db
    .query<SongValues, [string]>(
      `SELECT path, ${COLUMN_FIELDS.map((c) => `"${c}"`).join(', ')} FROM library_songs WHERE id = ?`,
    )
    .get(songId);
  if (!row) return null;
  const tags: Record<string, unknown> = {};
  for (const f of fields) {
    if (f === 'genre') {
      const set = loadGenreSets(db, [songId]).get(songId) ?? [];
      if (set.length > 0) tags.genre = set.join('; ');
      continue;
    }
    const v = row[f];
    if (v === null || v === undefined || v === '') continue;
    tags[f] = v;
  }
  return { path: row.path, tags: tags as FlushTags };
}

/**
 * Write every pending song's merged tags once, through the same writer and
 * size re-anchoring the per-task write used. Songs are independent: one song's
 * failure or absence never touches another's row.
 *
 * Idempotent — values are re-read at flush time, so re-running writes the same
 * bytes. A failed write is logged and dropped, matching the per-task write it
 * replaces (the DB is authoritative; the tag is a best-effort mirror).
 */
export async function flushPendingTagWrites(
  db: Database,
  deps: FlushDeps,
  opts: { songIds?: readonly string[] } = {},
): Promise<FlushResult> {
  const result: FlushResult = { written: 0, failed: 0, dropped: 0, retained: 0 };
  const all = db
    .query<{ song_id: string; fields: string; enqueued_at: number }, []>(
      'SELECT song_id, fields, enqueued_at FROM library_pending_tag_writes ORDER BY enqueued_at',
    )
    .all();
  const only = opts.songIds ? new Set(opts.songIds) : null;
  const rows = only ? all.filter((r) => only.has(r.song_id)) : all;

  const drop = (songId: string, enqueuedAt: number): void => {
    // Only the row as read: a re-enqueue during the write strictly bumps
    // enqueued_at (see enqueueTagWrite) and must survive to the next flush.
    db.run('DELETE FROM library_pending_tag_writes WHERE song_id = ? AND enqueued_at = ?', [
      songId,
      enqueuedAt,
    ]);
  };

  for (const r of rows) {
    const fields = parseFields(r.fields);
    const before = currentTags(db, r.song_id, fields);
    if (!before || Object.keys(before.tags).length === 0) {
      drop(r.song_id, r.enqueued_at);
      result.dropped++;
      continue;
    }
    const abs = resolveSongAbsPath(deps.musicDir, before.path);
    if (!deps.fileExists(abs)) {
      drop(r.song_id, r.enqueued_at);
      result.dropped++;
      continue;
    }
    let ok = false;
    try {
      ok = await deps.writeTags(abs, before.tags);
    } catch (err) {
      log.warn({ err, songId: r.song_id }, 'pending tag write threw');
      ok = false;
    }
    if (!ok) {
      log.warn({ songId: r.song_id, fields }, 'pending tag write failed; DB keeps the values');
      drop(r.song_id, r.enqueued_at);
      result.failed++;
      continue;
    }
    const size = deps.fileSize?.(abs) ?? null;
    if (size != null) rebaseAnalysisFileSize(db, r.song_id, size);
    // A curator edit that landed while the write was in flight may have been
    // overwritten on disk by the value read before it. Keep the row so the next
    // flush mirrors the newer DB value.
    const after = currentTags(db, r.song_id, fields);
    if (after && after.path === before.path && sameTags(after.tags, before.tags)) {
      drop(r.song_id, r.enqueued_at);
    } else {
      result.retained++;
    }
    result.written++;
  }
  return result;
}

function sameTags(a: FlushTags, b: FlushTags): boolean {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  return ka.every(
    (k, i) =>
      k === kb[i] && (a as Record<string, unknown>)[k] === (b as Record<string, unknown>)[k],
  );
}
