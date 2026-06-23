import type { Database } from 'bun:sqlite';
import type { LyricsDto } from '@nicotind/core';

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
}

export interface SetLyricsInput {
  plain: string | null;
  synced: string | null;
  source: string | null;
  /** True when a user edited the text — protects it from being re-fetched. */
  customized: boolean;
}

function toDto(r: DbRow): LyricsDto {
  return {
    plain: r.plain_text,
    synced: r.synced_text,
    source: r.source,
    customized: r.customized === 1,
    updatedAt: r.updated_at,
  };
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
  db.run(
    `INSERT INTO library_lyrics
       (song_id, plain_text, synced_text, source, customized, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(song_id) DO UPDATE SET
       plain_text = excluded.plain_text,
       synced_text = excluded.synced_text,
       source = excluded.source,
       customized = excluded.customized,
       updated_at = excluded.updated_at`,
    [songId, input.plain, input.synced, input.source, input.customized ? 1 : 0, updatedAt],
  );
  return {
    plain: input.plain,
    synced: input.synced,
    source: input.source,
    customized: input.customized,
    updatedAt,
  };
}

/** Delete a song's lyrics row (reset). */
export function deleteLyrics(db: Database, songId: string): void {
  db.run('DELETE FROM library_lyrics WHERE song_id = ?', [songId]);
}
