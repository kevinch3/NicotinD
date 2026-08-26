import type { Database } from 'bun:sqlite';
import type { Lidarr, LidarrAlbum } from '@nicotind/lidarr-client';
import { createLogger } from '@nicotind/core';
import { normalizeForGrouping } from './album-grouping.js';
import { setArtwork, pickAlbumCover, missingAlbumArtSql } from './artwork-store.js';
import { setReleaseType, mapLidarrAlbumType } from './release-meta-store.js';
import { looksLikeNonAlbum, normalizeName, isPlaceholderArtist } from './artwork-backfill.js';
import { clearCoverNegativeCache } from '../routes/streaming.js';

const log = createLogger('metadata-optimize');

/** Lidarr surface the optimizer needs — narrowed so tests can inject a mock. */
export type OptimizeLidarr = Pick<Lidarr, 'album' | 'track'>;

export interface OptimizeAlbumResult {
  /** A confident Lidarr release-group matched this album. */
  matched: boolean;
  coverUpdated: boolean;
  yearUpdated: boolean;
  releaseTypeUpdated: boolean;
  /** Songs whose NULL `track` this pass filled from the canonical tracklist. */
  tracksNumbered: number;
  /**
   * False when the album was skipped before any Lidarr call (row missing, junk
   * grouping, placeholder artist). Lets the bulk pass report work actually done
   * rather than rows selected — a timed-out lookup still counts, it burned the
   * full `TIMEOUT_LOOKUP_MS` budget.
   */
  lookedUp: boolean;
}

export interface OptimizeAllResult {
  /** Rows the scope query selected — the denominator for this pass. */
  candidates: number;
  /** Albums the loop actually visited (< candidates when cancelled). */
  visited: number;
  /** Of those, the ones that reached a Lidarr lookup. This is "work done". */
  lookedUp: number;
  matched: number;
  coversUpdated: number;
  yearsUpdated: number;
  /** Songs given a track number from the canonical tracklist (issue #694). */
  tracksNumbered: number;
  releaseTypesUpdated: number;
  /** Albums whose write step threw; the pass carried on past them. */
  failed: number;
  /** First failure message, for surfacing without a log dive. */
  errorSample: string | null;
  /** True when work may remain — cancelled, or the limit filled a full page. */
  stopped: boolean;
  /** Last visited id; feed back as `afterId` to continue. */
  cursor: string | null;
}

/** Cumulative progress, emitted after each album. */
export interface OptimizeProgress {
  total: number;
  visited: number;
  /** "<artist> — <name>" of the album just visited. */
  label: string;
  result: OptimizeAllResult;
}

export interface OptimizeAllOptions {
  apply: boolean;
  coverCacheDir?: string;
  onlyMissingOrPoor?: boolean;
  /** Max albums to visit. Omitted/<=0 → unbounded. */
  limit?: number;
  /** Resume cursor: only consider ids strictly greater than this. */
  afterId?: string | null;
  /** Checked before each album; true → stop and return the partial counters. */
  shouldStop?: () => boolean;
  onProgress?: (p: OptimizeProgress) => void;
  /** Test seam — defaults to the real `optimizeAlbum`. */
  optimizeOne?: (albumId: string) => Promise<OptimizeAlbumResult>;
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
 *
 * Deliberately has no try/catch around its writes: the per-album admin route
 * must keep surfacing a write failure as a 500. Isolation is a property of the
 * *bulk* caller — see `optimizeAllAlbums`.
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
    tracksNumbered: 0,
    lookedUp: false,
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
  // Set on the degrade path too: a timeout consumed the whole lookup budget.
  out.lookedUp = true;
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

  out.tracksNumbered = await fillTrackNumbers(db, lidarr, album.id, match, opts.apply);

  return out;
}

/**
 * Minimum share of an album's un-numbered songs that must appear in the canonical
 * tracklist before any of them are numbered. Below it the local folder is not the
 * same release (a bootleg, a mixtape, a mis-grouped folder) and numbering the one
 * or two that happen to match would interleave real positions with NULLs — worse
 * than leaving the album unnumbered, because the player would sort on it.
 */
const TRACK_MATCH_FLOOR = 0.6;

/**
 * Fill `library_songs.track` for songs that have none, from Lidarr's canonical
 * tracklist (issue #694).
 *
 * Nothing wrote `track` after the scan: the scanner reads `common.track.no` from
 * tags and there is no fallback, so a source that omits TRACKNUMBER — yt-dlp,
 * every YT Music download — left the whole album at NULL forever and its running
 * order arbitrary.
 *
 * Only fills NULLs: a number from the file's own tags, or a curator, is better
 * evidence than a title match and is never overwritten. All-or-nothing per album
 * via {@link TRACK_MATCH_FLOOR}.
 *
 * Requires the matched release to exist in Lidarr's *library* — `track?albumId=`
 * is the library endpoint, and an un-provisioned lookup hit carries no `id`. That
 * is a quiet no-op rather than an error: this is opportunistic repair, and
 * provisioning an artist just to number tracks would be a much bigger action than
 * the user asked for.
 */
async function fillTrackNumbers(
  db: Database,
  lidarr: OptimizeLidarr,
  albumId: string,
  match: LidarrAlbum,
  apply: boolean,
): Promise<number> {
  const lidarrAlbumId = match.id;
  if (!lidarrAlbumId) return 0;

  const songs = db
    .query<{ id: string; title: string }, [string]>(
      'SELECT id, title FROM library_songs WHERE album_id = ? AND track IS NULL',
    )
    .all(albumId);
  if (songs.length === 0) return 0;

  const tracks = await lidarr.track.listByAlbum(lidarrAlbumId).catch((err) => {
    log.warn({ err, albumId }, 'Lidarr tracklist fetch failed');
    return [];
  });
  if (tracks.length === 0) return 0;

  // `normalizeForGrouping` is the shared, diacritic-folding normalizer already
  // used for the album title above — reused rather than re-implemented so
  // "Canción" folds instead of being mangled (cf. #662).
  const byTitle = new Map<string, number>();
  for (const t of tracks) {
    const n = Number.parseInt(String(t.trackNumber), 10);
    if (!Number.isFinite(n)) continue;
    byTitle.set(normalizeForGrouping(t.title), n);
  }

  const hits = songs
    .map((s) => ({ id: s.id, track: byTitle.get(normalizeForGrouping(s.title)) }))
    .filter((x): x is { id: string; track: number } => x.track != null);

  if (hits.length / songs.length < TRACK_MATCH_FLOOR) return 0;

  if (apply) {
    const write = db.transaction(() => {
      for (const h of hits) {
        db.run('UPDATE library_songs SET track = ? WHERE id = ? AND track IS NULL', [
          h.track,
          h.id,
        ]);
      }
    });
    write();
  }
  return hits.length;
}

/**
 * Optimize metadata across the library. `onlyMissingOrPoor` (default true)
 * restricts to albums that have no canonical artwork yet or no year — the ones
 * most likely wrong/empty — so a routine run stays cheap; pass `false` to
 * re-verify every album. One `album.lookup` per candidate, junk groupings
 * skipped by `optimizeAlbum`.
 *
 * Deliberately serial (issue #622): `album.lookup` proxies to Lidarr's shared
 * upstream metadata server, so fanning out invites rate-limiting — the same
 * reason the two network-facing enrichment tasks cap their pool at 2. The fix
 * for "this takes hours" is that the caller runs it as a background job, not
 * that it runs four at a time and is still unbounded.
 */
export async function optimizeAllAlbums(
  db: Database,
  lidarr: OptimizeLidarr,
  opts: OptimizeAllOptions,
): Promise<OptimizeAllResult> {
  const onlyMissingOrPoor = opts.onlyMissingOrPoor ?? true;
  const limit = opts.limit != null && opts.limit > 0 ? opts.limit : -1; // SQLite: negative = no limit
  const afterId = opts.afterId ?? null;
  // `ORDER BY id` is index-backed (id is TEXT PRIMARY KEY) and load-bearing: without
  // a stable order a bounded pass re-walks an arbitrary head on every call.
  // "Missing or poor" also covers an album with un-numbered songs (issue #694):
  // without this the repair could never reach the albums that need it most —
  // a yt-dlp download carries no TRACKNUMBER but often does have a year and a
  // cover, so it would never be selected as a candidate.
  const scope = onlyMissingOrPoor
    ? `(year IS NULL
         OR ${missingAlbumArtSql()}
         OR EXISTS (
           SELECT 1 FROM library_songs s WHERE s.album_id = library_albums.id AND s.track IS NULL
         ))`
    : '1 = 1';
  const rows = db
    .query<Pick<AlbumRow, 'id' | 'name' | 'artist'>, [string | null, string | null, number]>(
      `SELECT id, name, artist FROM library_albums
        WHERE ${scope}
          AND (? IS NULL OR id > ?)
        ORDER BY id
        LIMIT ?`,
    )
    .all(afterId, afterId, limit);

  const result: OptimizeAllResult = {
    candidates: rows.length,
    visited: 0,
    lookedUp: 0,
    matched: 0,
    coversUpdated: 0,
    yearsUpdated: 0,
    tracksNumbered: 0,
    releaseTypesUpdated: 0,
    failed: 0,
    errorSample: null,
    stopped: false,
    cursor: null,
  };
  const optimizeOne =
    opts.optimizeOne ??
    ((albumId: string) =>
      optimizeAlbum(db, lidarr, albumId, {
        apply: opts.apply,
        coverCacheDir: opts.coverCacheDir,
      }));

  for (const row of rows) {
    if (opts.shouldStop?.()) {
      result.stopped = true;
      break;
    }
    result.visited += 1;
    try {
      const r = await optimizeOne(row.id);
      if (r.lookedUp) result.lookedUp += 1;
      if (r.matched) result.matched += 1;
      if (r.coverUpdated) result.coversUpdated += 1;
      if (r.yearUpdated) result.yearsUpdated += 1;
      result.tracksNumbered += r.tracksNumbered;
      if (r.releaseTypeUpdated) result.releaseTypesUpdated += 1;
    } catch (err) {
      // One album's write failure must not discard every counter accumulated so
      // far — before #622 it rejected the whole pass.
      result.failed += 1;
      result.errorSample ??= err instanceof Error ? err.message : String(err);
      log.warn({ err, albumId: row.id }, 'album optimize failed; continuing');
    }
    result.cursor = row.id;
    opts.onProgress?.({
      total: rows.length,
      visited: result.visited,
      label: `${row.artist} — ${row.name}`,
      result,
    });
  }
  // A full page means there may be more behind it; `cursor` continues the walk.
  if (limit > 0 && rows.length === limit) result.stopped = true;
  log.info({ ...result, apply: opts.apply }, 'metadata optimize pass complete');
  return result;
}
