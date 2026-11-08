import type { Database } from 'bun:sqlite';
import type {
  LyricsActor,
  LyricsChoice,
  LyricsDto,
  LyricsExportDto,
  LyricsProvenance,
} from '@nicotind/core';
import { LYRICS_OFFSET_MAX_MS, bakeLyricsOffset } from '@nicotind/core';
import { libraryEvents } from './library-events.js';

/**
 * Persisted lyrics for a single song, keyed on the scanner's path-derived songId.
 * Fetched on demand from a lyrics-capable plugin, then optionally edited by the
 * user. Same side-table pattern as `metadata-override-store.ts` / `artwork-store.ts`.
 *
 * Every write here announces itself as `lyrics.changed` (#1666): these three
 * functions are the only writers of `library_lyrics` rows a client may hold, so
 * the REST routes, the fetch path and the MCP tools all reach an open client —
 * a phone edit reaches the TV's karaoke — without each caller remembering to.
 */
function announce(songId: string): void {
  libraryEvents.emit({ type: 'lyrics.changed', songIds: [songId] });
}

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
  choice_json: string | null;
  customized_by: string | null;
  customized_at: number | null;
  offset_by: string | null;
  offset_at: number | null;
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
  /**
   * Why these words were chosen (#1676). **Omitted keeps the stored one**: a
   * user edit changes the text, not where it came from, and the record it
   * started from is what a corrected version would be shared back to.
   */
  choice?: LyricsChoice;
  /** User id of whoever wrote a `customized` row; recorded with the time. */
  actor?: string | null;
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
  const keepChoice = input.choice === undefined ? 1 : 0;
  const keepOffsetBy = input.offsetMs === undefined ? 0 : 1;
  db.run(
    `INSERT INTO library_lyrics
       (song_id, plain_text, synced_text, source, customized, updated_at,
        matched_duration, source_id, offset_ms, choice_json, customized_by, customized_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(song_id) DO UPDATE SET
       plain_text = excluded.plain_text,
       synced_text = excluded.synced_text,
       source = excluded.source,
       customized = excluded.customized,
       updated_at = excluded.updated_at,
       matched_duration = excluded.matched_duration,
       source_id = excluded.source_id,
       offset_ms = excluded.offset_ms,
       choice_json = CASE WHEN ? THEN library_lyrics.choice_json ELSE excluded.choice_json END,
       customized_by = excluded.customized_by,
       customized_at = excluded.customized_at,
       offset_by = CASE WHEN ? THEN library_lyrics.offset_by END,
       offset_at = CASE WHEN ? THEN library_lyrics.offset_at END`,
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
      input.choice ? JSON.stringify(input.choice) : null,
      input.customized ? (input.actor ?? null) : null,
      input.customized ? updatedAt : null,
      keepChoice,
      keepOffsetBy,
      keepOffsetBy,
    ],
  );
  announce(songId);
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
export function setLyricsOffset(
  db: Database,
  songId: string,
  offsetMs: number,
  actor: string | null = null,
): LyricsDto | null {
  const existing = getLyrics(db, songId);
  if (!existing) return null;
  const clamped = clampLyricsOffset(offsetMs);
  const updatedAt = Date.now();
  db.run(
    `UPDATE library_lyrics SET offset_ms = ?, updated_at = ?, offset_by = ?, offset_at = ?
     WHERE song_id = ?`,
    [clamped, updatedAt, actor, updatedAt, songId],
  );
  announce(songId);
  return { ...existing, offsetMs: clamped, updatedAt };
}

function parseChoice(json: string | null): LyricsChoice | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as LyricsChoice;
  } catch {
    return null;
  }
}

type ProvenanceRow = DbRow & { customized_name: string | null; offset_name: string | null };

const actor = (id: string | null, name: string | null): LyricsActor | null =>
  id ? { userId: id, username: name } : null;

function toProvenance(r: ProvenanceRow): LyricsProvenance {
  return {
    source: r.source,
    sourceTrackId: r.source_id,
    choice: parseChoice(r.choice_json),
    customized: r.customized === 1,
    customizedBy: actor(r.customized_by, r.customized_name),
    customizedAt: r.customized_at,
    offsetBy: actor(r.offset_by, r.offset_name),
    offsetAt: r.offset_at,
  };
}

function provenanceRow(db: Database, songId: string): ProvenanceRow | null {
  return db
    .query<ProvenanceRow, [string]>(
      `SELECT l.*, cu.username AS customized_name, ou.username AS offset_name
       FROM library_lyrics l
       LEFT JOIN users cu ON cu.id = l.customized_by
       LEFT JOIN users ou ON ou.id = l.offset_by
       WHERE l.song_id = ?`,
    )
    .get(songId);
}

/** Where a song's stored lyrics came from and who corrected them, or null if none. */
export function getLyricsProvenance(db: Database, songId: string): LyricsProvenance | null {
  const row = provenanceRow(db, songId);
  return row ? toProvenance(row) : null;
}

/**
 * A song's lyrics in the shape a future share-back would send (#1676): the
 * stored offset **baked into** the LRC, because the corrected timings are what
 * the listener heard and a source has no field for a separate offset. Null when
 * the song or its lyrics row is missing. Read-only — nothing is uploaded.
 */
export function getLyricsExport(db: Database, songId: string): LyricsExportDto | null {
  const song = db
    .query<{ title: string; artist: string; duration: number; album: string | null }, [string]>(
      `SELECT s.title, s.artist, s.duration, a.name AS album
       FROM library_songs s LEFT JOIN library_albums a ON a.id = s.album_id
       WHERE s.id = ?`,
    )
    .get(songId);
  const row = song ? provenanceRow(db, songId) : null;
  if (!song || !row) return null;
  const offsetMs = row.offset_ms ?? 0;
  return {
    songId,
    title: song.title,
    artist: song.artist,
    album: song.album,
    durationSec: song.duration > 0 ? song.duration : null,
    plain: row.plain_text,
    synced: row.synced_text ? bakeLyricsOffset(row.synced_text, offsetMs) : null,
    offsetAppliedMs: row.synced_text ? offsetMs : 0,
    corrected: row.customized === 1 || (!!row.synced_text && offsetMs !== 0),
    provenance: toProvenance(row),
  };
}

/** Delete a song's lyrics row (reset). */
export function deleteLyrics(db: Database, songId: string): void {
  if (db.run('DELETE FROM library_lyrics WHERE song_id = ?', [songId]).changes > 0) {
    announce(songId);
  }
}
