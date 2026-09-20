import type { Database } from 'bun:sqlite';
import type { LyricsDto } from '@nicotind/core';
import { LYRICS_OFFSET_MAX_MS } from '@nicotind/core';

/**
 * Persisted lyrics for a single song, keyed on the scanner's path-derived songId.
 * Fetched on demand from a lyrics-capable plugin, then optionally edited by the
 * user. Same side-table pattern as `metadata-override-store.ts` / `artwork-store.ts`.
 */

interface DbRow {
  song_id: string;
  plain_text: string | null;
  synced_text: string | null;
  source: string | null;
  customized: number;
  updated_at: number;
  matched_duration: number | null;
  source_id: string | null;
  offset_ms: number | null;
}

export interface SetLyricsInput {
  plain: string | null;
  synced: string | null;
  source: string | null;
  /** True when a user edited the text — protects it from being re-fetched. */
  customized: boolean;
  /**
   * Length of the recording the source matched, when it reported one. Null
   * means the match was never verified against the local file's duration —
   * which is a distinct state from "verified and close" (issue #1212).
   */
  matchedDurationSec?: number | null;
  /** The source's own id for the matched record. */
  sourceTrackId?: string | null;
  /**
   * Sync correction to carry over. Omitted means **0**, which is the point:
   * `setLyrics` writes new text, and a correction measured against text that is
   * being replaced is meaningless. Only `setLyricsOffset` sets this deliberately.
   */
  offsetMs?: number;
}

function toDto(r: DbRow): LyricsDto {
  return {
    plain: r.plain_text,
    synced: r.synced_text,
    source: r.source,
    customized: r.customized === 1,
    updatedAt: r.updated_at,
    matchedDurationSec: r.matched_duration,
    sourceTrackId: r.source_id,
    offsetMs: r.offset_ms ?? 0,
  };
}

/** Keep a stored offset inside the range the UI and the MCP tool both promise. */
export function clampLyricsOffset(ms: unknown): number {
  const n = typeof ms === 'number' && Number.isFinite(ms) ? Math.round(ms) : 0;
  return Math.max(-LYRICS_OFFSET_MAX_MS, Math.min(LYRICS_OFFSET_MAX_MS, n));
}

/** Resolve stored lyrics for a songId, or null if none. */
export function getLyrics(db: Database, songId: string): LyricsDto | null {
  const row = db
    .query<DbRow, [string]>('SELECT * FROM library_lyrics WHERE song_id = ?')
    .get(songId);
  return row ? toDto(row) : null;
}

/** Upsert lyrics for a songId. */
export function setLyrics(db: Database, songId: string, input: SetLyricsInput): LyricsDto {
  const updatedAt = Date.now();
  const matchedDurationSec = input.matchedDurationSec ?? null;
  const sourceTrackId = input.sourceTrackId ?? null;
  const offsetMs = clampLyricsOffset(input.offsetMs ?? 0);
  db.run(
    `INSERT INTO library_lyrics
       (song_id, plain_text, synced_text, source, customized, updated_at,
        matched_duration, source_id, offset_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(song_id) DO UPDATE SET
       plain_text = excluded.plain_text,
       synced_text = excluded.synced_text,
       source = excluded.source,
       customized = excluded.customized,
       updated_at = excluded.updated_at,
       matched_duration = excluded.matched_duration,
       source_id = excluded.source_id,
       offset_ms = excluded.offset_ms`,
    [
      songId,
      input.plain,
      input.synced,
      input.source,
      input.customized ? 1 : 0,
      updatedAt,
      matchedDurationSec,
      sourceTrackId,
      offsetMs,
    ],
  );
  return {
    plain: input.plain,
    synced: input.synced,
    source: input.source,
    customized: input.customized,
    updatedAt,
    matchedDurationSec,
    sourceTrackId,
    offsetMs,
  };
}

/**
 * Set only the sync offset, leaving the text untouched. Separate from
 * `setLyrics` on purpose: that one is a full-column upsert whose whole job is
 * to replace the text, and routing a timing correction through it would make
 * every caller responsible for round-tripping words it never meant to write.
 *
 * Returns null when there is no row to correct — an offset with no lyrics
 * behind it is not a thing to store.
 */
export function setLyricsOffset(db: Database, songId: string, offsetMs: number): LyricsDto | null {
  const existing = getLyrics(db, songId);
  if (!existing) return null;
  const clamped = clampLyricsOffset(offsetMs);
  const updatedAt = Date.now();
  db.run('UPDATE library_lyrics SET offset_ms = ?, updated_at = ? WHERE song_id = ?', [
    clamped,
    updatedAt,
    songId,
  ]);
  return { ...existing, offsetMs: clamped, updatedAt };
}

/** Delete a song's lyrics row (reset). */
export function deleteLyrics(db: Database, songId: string): void {
  db.run('DELETE FROM library_lyrics WHERE song_id = ?', [songId]);
}
