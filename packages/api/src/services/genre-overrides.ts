/**
 * Genre overrides — the write path that can REPLACE a song's primary genre
 * (issue #187 task A3), as opposed to `appendSongGenres` which can only add.
 *
 * Why a side table rather than a `genre_source` column: a rescan deletes and
 * rebuilds `library_song_genres` wholesale from file tags (see
 * `library-scanner.ts` "Replace (not merge) each rescanned song's genre set").
 * `library_songs.genre` is COALESCE-preserved, but the join rows the radio
 * scorer actually reads (`genreSetCloseness`) are not — so a column would be
 * silently reverted on the next scan whenever the file-tag mirror write failed.
 * Overrides therefore live in a side table that `buildLibrary` applies at scan
 * time, exactly like `library_genre_aliases`/`library_artist_aliases`. File-tag
 * mirroring becomes best-effort rather than load-bearing.
 *
 * Rows are keyed at the granularity the SOURCE provides — MusicBrainz supplies
 * genres per release-group (album), Lidarr per artist, a future Essentia head
 * per track — so one row fixes every song it covers, survives file moves
 * (artist/album keys are name-derived, song ids are path-derived), and is
 * inherited automatically by tracks downloaded later.
 */

import type { Database } from 'bun:sqlite';

import { albumGroupKey, normalizeArtistForGrouping } from './album-grouping.js';
import { genreKey } from './genre-split.js';

export type GenreOverrideScope = 'artist' | 'album' | 'song';
/** 'essentia' is reserved for issue #187 task A2; nothing writes it yet. */
export type GenreOverrideSource = 'musicbrainz' | 'lidarr' | 'user' | 'essentia';
export type GenreOverrideStatus = 'applied' | 'pending' | 'rejected';

export interface GenreOverrideRow {
  scope: GenreOverrideScope;
  key: string;
  /** Ordered, primary first. Empty = suppress every genre (junk drop). */
  genres: string[];
  source: GenreOverrideSource;
  mbid: string | null;
  confidence: number | null;
  status: GenreOverrideStatus;
  note: string | null;
}

export interface OverrideEntry {
  genres: string[];
  source: GenreOverrideSource;
}

export interface OverrideIndex {
  artist: Map<string, OverrideEntry>;
  album: Map<string, OverrideEntry>;
  song: Map<string, OverrideEntry>;
}

export function emptyOverrideIndex(): OverrideIndex {
  return { artist: new Map(), album: new Map(), song: new Map() };
}

/** Index only the `applied` rows — `pending`/`rejected` must not touch the library. */
export function buildOverrideIndex(rows: readonly GenreOverrideRow[]): OverrideIndex {
  const idx = emptyOverrideIndex();
  for (const r of rows) {
    if (r.status !== 'applied') continue;
    idx[r.scope].set(r.key, { genres: r.genres, source: r.source });
  }
  return idx;
}

/**
 * Resolve a song's genre set: the most specific matching override scope wins
 * outright (song > album > artist — scopes are never merged with each other).
 * An override with no genres suppresses the set entirely.
 *
 * How the override combines with the tag genres depends on who wrote it, and
 * this distinction is load-bearing rather than cosmetic:
 *
 * - `source='user'` **replaces** the set outright. `genreSetCloseness` (the
 *   radio's genre axis) is a position-blind MAX over every pair, so leaving a
 *   broad tag genre in place keeps scoring 1.00 against everything in that broad
 *   genre and completely masks the correction. Measured: after overriding José
 *   Larralde to Folclore/Chacarera while retaining his `Latin` tag, his radio
 *   still surfaced Enrique Iglesias and Babasónicos at genre 1.00. A curator who
 *   types the exact list means that list; Reset restores the tag genres.
 * - automated sources **prepend and keep the rest**, so the primary is corrected
 *   while nothing is destroyed — the right trade-off when a machine picked the
 *   genres and might be wrong.
 */
export function applyGenreOverride(
  ovr: OverrideIndex,
  keys: { songId: string; albumKey: string; artistKey: string },
  tagGenres: readonly string[],
): string[] {
  const hit =
    ovr.song.get(keys.songId) ?? ovr.album.get(keys.albumKey) ?? ovr.artist.get(keys.artistKey);
  if (!hit) return [...tagGenres];
  if (hit.genres.length === 0) return [];
  if (hit.source === 'user') return dedupe(hit.genres);

  return dedupe([...hit.genres, ...tagGenres]);
}

function dedupe(genres: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const g of genres) {
    const k = genreKey(g);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(g.trim().replace(/\s+/g, ' '));
  }
  return out;
}

interface OverrideDbRow {
  scope: string;
  key: string;
  genres: string;
  source: string;
  status: string;
}

/**
 * Load the applied overrides. Missing table → empty index (fresh db / a
 * pre-migration snapshot), same defensive shape as `loadGenreContext`.
 */
export function loadGenreOverrides(db: Database): OverrideIndex {
  const idx = emptyOverrideIndex();
  let rows: OverrideDbRow[];
  try {
    rows = db
      .query<OverrideDbRow, []>(
        `SELECT scope, key, genres, source, status FROM library_genre_overrides WHERE status = 'applied'`,
      )
      .all();
  } catch {
    return idx;
  }
  for (const r of rows) {
    const scope = r.scope as GenreOverrideScope;
    if (scope !== 'artist' && scope !== 'album' && scope !== 'song') continue;
    idx[scope].set(r.key, {
      genres: splitStored(r.genres),
      source: r.source as GenreOverrideSource,
    });
  }
  return idx;
}

/** Stored form is a ';'-joined ordered list; '' means "suppress everything". */
export function splitStored(genres: string): string[] {
  return genres
    .split(';')
    .map((g) => g.trim().replace(/\s+/g, ' '))
    .filter(Boolean);
}

export function joinStored(genres: readonly string[]): string {
  return genres
    .map((g) => g.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join(';');
}

/**
 * Write one override. A `source='user'` row is permanent: no automated source
 * may overwrite it (same contract as `library_artist_identity` and
 * `licence_source='user'`). Returns whether the row was written.
 */
export function upsertGenreOverride(db: Database, row: GenreOverrideRow): boolean {
  const existing = db
    .query<{ source: string }, [string, string]>(
      `SELECT source FROM library_genre_overrides WHERE scope = ? AND key = ?`,
    )
    .get(row.scope, row.key);
  if (existing?.source === 'user' && row.source !== 'user') return false;

  const now = Date.now();
  db.run(
    `INSERT INTO library_genre_overrides
       (scope, key, genres, source, mbid, confidence, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET
       genres = excluded.genres,
       source = excluded.source,
       mbid = excluded.mbid,
       confidence = excluded.confidence,
       status = excluded.status,
       note = excluded.note,
       updated_at = excluded.updated_at`,
    [
      row.scope,
      row.key,
      joinStored(row.genres),
      row.source,
      row.mbid,
      row.confidence,
      row.status,
      row.note,
      now,
      now,
    ],
  );
  return true;
}

/**
 * Re-apply every applied override to the *stored* genre sets, so a newly-written
 * override takes effect without waiting for a scan — the same role
 * `backfillGenresFromAliases` plays for the alias table.
 *
 * Needed because the scan is what normally applies overrides, and a full scan of
 * a large library is minutes of work for what is otherwise an instant edit. The
 * result is identical to what the next scan would compute, so this is a
 * short-cut, never a divergence.
 */
export function backfillGenreOverrides(
  db: Database,
  setSongGenres: (db: Database, songId: string, genres: string[]) => void,
): { scanned: number; updated: number } {
  const idx = loadGenreOverrides(db);
  if (idx.artist.size === 0 && idx.album.size === 0 && idx.song.size === 0) {
    return { scanned: 0, updated: 0 };
  }

  // Keys must be computed with the SAME normalizers buildLibrary uses — a SQL
  // LOWER()/TRIM() approximation would miss every diacritic and punctuation
  // case and silently fail to apply the override.
  const rows = db
    .query<
      { id: string; album_artist: string | null; artist: string; album_name: string | null },
      []
    >(
      `SELECT s.id, s.album_artist, s.artist, al.name AS album_name, al.artist AS album_row_artist
         FROM library_songs s
         LEFT JOIN library_albums al ON al.id = s.album_id`,
    )
    .all();

  let updated = 0;
  let scanned = 0;
  for (const r of rows) {
    scanned++;
    const groupArtist = r.album_artist ?? r.artist;
    const existing = db
      .query<{ genre: string }, [string]>(
        `SELECT genre FROM library_song_genres WHERE song_id = ? ORDER BY position`,
      )
      .all(r.id)
      .map((g) => g.genre);
    const next = applyGenreOverride(
      idx,
      {
        songId: r.id,
        albumKey: albumGroupKey(groupArtist, r.album_name ?? ''),
        artistKey: normalizeArtistForGrouping(groupArtist),
      },
      existing,
    );
    if (next.length === existing.length && next.every((g, i) => g === existing[i])) continue;
    setSongGenres(db, r.id, next);
    updated++;
  }
  return { scanned, updated };
}

export function deleteGenreOverride(db: Database, scope: GenreOverrideScope, key: string): boolean {
  const res = db.run(`DELETE FROM library_genre_overrides WHERE scope = ? AND key = ?`, [
    scope,
    key,
  ]);
  return Number(res.changes ?? 0) > 0;
}

/** The one row for a scope+key regardless of status (the UI needs pending too). */
export function getGenreOverride(
  db: Database,
  scope: GenreOverrideScope,
  key: string,
): GenreOverrideRow | null {
  let r;
  try {
    r = db
      .query<
        {
          scope: string;
          key: string;
          genres: string;
          source: string;
          mbid: string | null;
          confidence: number | null;
          status: string;
          note: string | null;
        },
        [string, string]
      >(
        `SELECT scope, key, genres, source, mbid, confidence, status, note
           FROM library_genre_overrides WHERE scope = ? AND key = ?`,
      )
      .get(scope, key);
  } catch {
    return null;
  }
  if (!r) return null;
  return {
    scope: r.scope as GenreOverrideScope,
    key: r.key,
    genres: splitStored(r.genres),
    source: r.source as GenreOverrideSource,
    mbid: r.mbid,
    confidence: r.confidence,
    status: r.status as GenreOverrideStatus,
    note: r.note,
  };
}
