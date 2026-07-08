import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import { createLogger } from '@nicotind/core';
import { normalizeForGrouping } from './album-grouping.js';
import { setArtwork, pickAlbumCover } from './artwork-store.js';
import { setReleaseType, mapLidarrAlbumType } from './release-meta-store.js';
import { looksLikeNonAlbum, normalizeName, isPlaceholderArtist } from './artwork-backfill.js';
import { clearCoverNegativeCache } from '../routes/streaming.js';

const log = createLogger('metadata-optimize');

/** Lidarr surface the optimizer needs — narrowed so tests can inject a mock. */
export type OptimizeLidarr = Pick<Lidarr, 'album'>;

export interface OptimizeAlbumResult {
  /** A confident Lidarr release-group matched this album. */
  matched: boolean;
  coverUpdated: boolean;
  yearUpdated: boolean;
  releaseTypeUpdated: boolean;
}

export interface OptimizeAllResult {
  albums: number;
  matched: number;
  coversUpdated: number;
  yearsUpdated: number;
  releaseTypesUpdated: number;
}

interface AlbumRow {
  id: string;
  name: string;
  artist: string;
  year: number | null;
}

/** Parse a 4-digit year from a Lidarr `releaseDate`, dropping placeholders. */
function parseReleaseYear(releaseDate: string | undefined): number | null {
  if (!releaseDate) return null;
  const m = releaseDate.match(/^(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  // Lidarr/MusicBrainz emit 0001 for "unknown"; ignore implausible years.
  if (y < 1900 || y > new Date().getFullYear() + 1) return null;
  return y;
}

/**
 * Re-fetch better metadata for a single album from Lidarr/MusicBrainz and
 * **overwrite** what's stored: canonical cover art (`library_artwork`, which also
 * purges the stale cover cache), the album `year`, and the authoritative release
 * type (`library_release_meta`). Unlike `backfillArtwork` — which only fills
 * *missing* art — this is the "fix a wrong/poor cover" path, so it always
 * replaces on a confident match.
 *
 * Matches the global `album.lookup("<artist> <title>")` by normalized title +
 * artist (same approach as the backfill's targeted pass). `apply: false` reports
 * what would change without writing.
 */
export async function optimizeAlbum(
  db: Database,
  lidarr: OptimizeLidarr,
  albumId: string,
  opts: { apply: boolean; coverCacheDir?: string },
): Promise<OptimizeAlbumResult> {
  const out: OptimizeAlbumResult = {
    matched: false,
    coverUpdated: false,
    yearUpdated: false,
    releaseTypeUpdated: false,
  };
  const album = db
    .query<AlbumRow, [string]>('SELECT id, name, artist, year FROM library_albums WHERE id = ?')
    .get(albumId);
  if (!album) return out;
  if (looksLikeNonAlbum(album.name, album.artist)) return out;
  // A placeholder artist ("<Desconocido>") can't be matched all-or-nothing (the
  // artist guard below would never pass, and the lookup is poisoned). These are
  // fixed via the user-driven metadata-fix modal, not the bulk optimizer.
  if (isPlaceholderArtist(album.artist)) return out;

  const hits = await lidarr.album.lookup(`${album.artist} ${album.name}`).catch((err) => {
    log.warn({ err, album: album.name }, 'Lidarr album lookup failed');
    return [];
  });
  const wantTitle = normalizeForGrouping(album.name);
  const wantArtist = normalizeName(album.artist);
  const match = hits.find(
    (h) =>
      normalizeForGrouping(h.title) === wantTitle &&
      (!h.artist?.artistName || normalizeName(h.artist.artistName) === wantArtist),
  );
  if (!match) return out;
  out.matched = true;

  const cover = pickAlbumCover(match.images);
  if (cover) {
    if (opts.apply) {
      setArtwork(db, album.id, 'album', cover, opts.coverCacheDir);
      clearCoverNegativeCache(album.id); // in case this id was 404-cached as artless
    }
    out.coverUpdated = true;
  }

  const year = parseReleaseYear(match.releaseDate);
  if (year != null && year !== album.year) {
    if (opts.apply) db.run('UPDATE library_albums SET year = ? WHERE id = ?', [year, album.id]);
    out.yearUpdated = true;
  }

  const releaseType = mapLidarrAlbumType(match.albumType);
  if (releaseType) {
    if (opts.apply) {
      setReleaseType(db, album.id, releaseType, { canonicalTitle: match.title, source: 'lidarr' });
    }
    out.releaseTypeUpdated = true;
  }

  return out;
}

/**
 * Optimize metadata across the library. `onlyMissingOrPoor` (default true)
 * restricts to albums that have no canonical artwork yet or no year — the ones
 * most likely wrong/empty — so a routine run stays cheap; pass `false` to
 * re-verify every album. One `album.lookup` per candidate, junk groupings
 * skipped by `optimizeAlbum`.
 */
export async function optimizeAllAlbums(
  db: Database,
  lidarr: OptimizeLidarr,
  opts: { apply: boolean; coverCacheDir?: string; onlyMissingOrPoor?: boolean },
): Promise<OptimizeAllResult> {
  const onlyMissingOrPoor = opts.onlyMissingOrPoor ?? true;
  const rows = onlyMissingOrPoor
    ? db
        .query<{ id: string }, []>(
          `SELECT id FROM library_albums
           WHERE year IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM library_artwork w WHERE w.id = library_albums.id AND w.kind = 'album'
              )`,
        )
        .all()
    : db.query<{ id: string }, []>('SELECT id FROM library_albums').all();

  const result: OptimizeAllResult = {
    albums: rows.length,
    matched: 0,
    coversUpdated: 0,
    yearsUpdated: 0,
    releaseTypesUpdated: 0,
  };
  for (const { id } of rows) {
    const r = await optimizeAlbum(db, lidarr, id, {
      apply: opts.apply,
      coverCacheDir: opts.coverCacheDir,
    });
    if (r.matched) result.matched += 1;
    if (r.coverUpdated) result.coversUpdated += 1;
    if (r.yearUpdated) result.yearsUpdated += 1;
    if (r.releaseTypeUpdated) result.releaseTypesUpdated += 1;
  }
  log.info({ ...result, apply: opts.apply }, 'metadata optimize pass complete');
  return result;
}
