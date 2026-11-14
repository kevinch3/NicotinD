import type { Database } from 'bun:sqlite';
import { albumIdFor } from './library-scanner.js';

/**
 * User-confirmed metadata corrections, keyed on the scanner's **raw** albumId
 * (derived from the unchanged on-disk tags). The scanner consults these inside
 * `resolveTags` and substitutes the corrected artist/album/year *before* it mints
 * the artistId/albumId, so a correction re-buckets the album and survives full
 * rescans without ever touching files (songId — path-derived — stays stable).
 *
 * Same side-table pattern as `release-meta-store.ts` / `artwork-store.ts`.
 */

export interface MetadataOverrideValue {
  artist?: string;
  album?: string;
  year?: number;
}

export interface MetadataOverrideRow extends MetadataOverrideValue {
  rawAlbumId: string;
  correctedAlbumId: string | null;
  source: string | null;
}

interface DbRow {
  raw_album_id: string;
  artist: string | null;
  album: string | null;
  year: number | null;
  corrected_album_id: string | null;
  source: string | null;
}

function toValue(r: DbRow): MetadataOverrideValue {
  const v: MetadataOverrideValue = {};
  if (r.artist != null) v.artist = r.artist;
  if (r.album != null) v.album = r.album;
  if (r.year != null) v.year = r.year;
  return v;
}

/** Resolve the override for a raw albumId, or null if none. */
export function getOverride(db: Database, rawAlbumId: string): MetadataOverrideValue | null {
  const row = db
    .query<DbRow, [string]>('SELECT * FROM library_metadata_overrides WHERE raw_album_id = ?')
    .get(rawAlbumId);
  return row ? toValue(row) : null;
}

/**
 * Find the override row whose *corrected* output is `albumId` — i.e. the album the
 * user currently sees is itself the product of a previous correction. Lets the
 * apply handler update the existing raw-keyed row instead of orphaning it.
 */
export function findByCorrectedId(db: Database, albumId: string): MetadataOverrideRow | null {
  const row = db
    .query<DbRow, [string]>('SELECT * FROM library_metadata_overrides WHERE corrected_album_id = ?')
    .get(albumId);
  return row
    ? {
        rawAlbumId: row.raw_album_id,
        correctedAlbumId: row.corrected_album_id,
        source: row.source,
        ...toValue(row),
      }
    : null;
}

/**
 * Key of a song-scoped override in the map `loadOverrides` returns. Album keys
 * are bare sha1 hex, so the prefix cannot collide with one.
 */
export function songOverrideKey(songId: string): string {
  return `song:${songId}`;
}

/**
 * Load every correction, threaded into the scanner build: album-scoped ones by
 * raw albumId, song-scoped ones (#1866) by {@link songOverrideKey}. One map, so
 * every build path that honours the first honours the second.
 */
export function loadOverrides(db: Database): Map<string, MetadataOverrideValue> {
  const rows = db.query<DbRow, []>('SELECT * FROM library_metadata_overrides').all();
  const map = new Map<string, MetadataOverrideValue>();
  for (const r of rows) map.set(r.raw_album_id, toValue(r));
  const songRows = db
    .query<{ song_id: string; artist: string | null; album: string; year: number | null }, []>(
      'SELECT song_id, artist, album, year FROM library_song_album_overrides',
    )
    .all();
  for (const r of songRows) {
    const v: MetadataOverrideValue = { album: r.album };
    if (r.artist != null) v.artist = r.artist;
    if (r.year != null) v.year = r.year;
    map.set(songOverrideKey(r.song_id), v);
  }
  return map;
}

/**
 * Pin one song to an album (#1866). Applied by the scanner after any album-scoped
 * correction, so it wins for that song. `artist` is the album artist.
 */
export function setSongAlbumOverride(
  db: Database,
  songId: string,
  value: { album: string; artist?: string; year?: number },
  opts: { source?: string } = {},
): void {
  db.run(
    `INSERT INTO library_song_album_overrides (song_id, artist, album, year, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(song_id) DO UPDATE SET
       artist = excluded.artist,
       album = excluded.album,
       year = excluded.year,
       source = excluded.source,
       updated_at = excluded.updated_at`,
    [
      songId,
      value.artist ?? null,
      value.album,
      value.year ?? null,
      opts.source ?? null,
      Date.now(),
    ],
  );
}

/**
 * Upsert a correction keyed on the raw albumId. `correctedAlbumId` is derived from
 * the corrected artist+album so {@link findByCorrectedId} can reverse-resolve it.
 */
export function setOverride(
  db: Database,
  rawAlbumId: string,
  value: MetadataOverrideValue,
  opts: { source?: string } = {},
): void {
  const correctedArtist = value.artist ?? null;
  const correctedAlbum = value.album ?? null;
  // Only compute a corrected id when we have both names; otherwise leave null.
  const correctedAlbumId =
    correctedArtist != null && correctedAlbum != null
      ? albumIdFor(correctedArtist, correctedAlbum)
      : null;
  db.run(
    `INSERT INTO library_metadata_overrides
       (raw_album_id, artist, album, year, corrected_album_id, source, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(raw_album_id) DO UPDATE SET
       artist = excluded.artist,
       album = excluded.album,
       year = excluded.year,
       corrected_album_id = excluded.corrected_album_id,
       source = excluded.source,
       updated_at = excluded.updated_at`,
    [
      rawAlbumId,
      correctedArtist,
      correctedAlbum,
      value.year ?? null,
      correctedAlbumId,
      opts.source ?? null,
      Date.now(),
    ],
  );
}
