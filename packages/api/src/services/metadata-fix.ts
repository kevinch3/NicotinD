import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import type { LidarrAlbum } from '@nicotind/lidarr-client';
import type { MetadataCandidate, ApplyMetadataRequest, MetadataReleaseType } from '@nicotind/core';
import { createLogger } from '@nicotind/core';
import { albumIdFor, artistIdFor } from './library-scanner.js';
import { pickAlbumCover } from './artwork-store.js';
import { setArtwork } from './artwork-store.js';
import { setReleaseType, mapLidarrAlbumType } from './release-meta-store.js';
import { setOverride, findByCorrectedId } from './metadata-override-store.js';
import { pruneOrphanArtist } from './library-aggregates.js';

const log = createLogger('metadata-fix');

/** Lidarr surface the candidate search needs — narrowed so tests can inject a mock. */
export type FixLidarr = Pick<Lidarr, 'album'>;

/** Parse a plausible 4-digit year, dropping MusicBrainz `0001` placeholders. */
function parseYear(releaseDate: string | undefined): number | null {
  if (!releaseDate) return null;
  const m = releaseDate.match(/^(\d{4})/);
  if (!m) return null;
  const y = Number(m[1]);
  if (y < 1900 || y > new Date().getFullYear() + 1) return null;
  return y;
}

/**
 * Diacritic-folding tokenizer for fuzzy scoring: NFD-strip accents ("Portuária" →
 * "portuaria"), lowercase, drop punctuation, split on whitespace.
 */
function scoreTokens(s: string): string[] {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // strip combining marks (diacritics)
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Score a candidate 0–100 by how many of the (diacritic-insensitive) query tokens
 * appear in the candidate's "artist title". Pure — unit-tested. Low scores are
 * kept on purpose: the user makes the final call, so a weak match is still shown.
 */
export function scoreCandidate(query: string, artist: string, title: string): number {
  const qTokens = scoreTokens(query);
  if (qTokens.length === 0) return 0;
  const cTokens = new Set(scoreTokens(`${artist} ${title}`));
  if (cTokens.size === 0) return 0;
  const matched = qTokens.filter((t) => cTokens.has(t)).length;
  return Math.round((matched / qTokens.length) * 100);
}

/**
 * Map Lidarr lookup hits to ranked metadata candidates for the user-driven fix
 * UI. Pure (no IO). Best-first by score; ties keep Lidarr's order. Caps the list
 * so the modal stays scannable.
 */
export function rankCandidates(hits: LidarrAlbum[], query: string, limit = 8): MetadataCandidate[] {
  const mapped: MetadataCandidate[] = hits.map((h) => {
    const artist = h.artist?.artistName ?? '';
    const cover = pickAlbumCover(h.images) ?? pickAlbumCover(h.artist?.images);
    return {
      releaseGroupId: h.foreignAlbumId ?? null,
      artist,
      title: h.title,
      year: parseYear(h.releaseDate),
      releaseType: mapLidarrAlbumType(h.albumType),
      coverUrl: cover ?? null,
      score: scoreCandidate(query, artist, h.title),
    };
  });
  return mapped.sort((a, b) => b.score - a.score).slice(0, limit);
}

interface AlbumRow {
  id: string;
  name: string;
  artist: string;
}

/**
 * Run a Lidarr lookup for the metadata fix modal. `query` defaults to the album's
 * current "<artist> <album>" but the caller (user) can override it — crucial when
 * the stored artist is wrong (e.g. "<Desconocido>") and poisons the default
 * query. Returns ranked candidates (possibly empty); throws are swallowed to [].
 */
export async function searchCandidates(
  db: Database,
  lidarr: FixLidarr,
  albumId: string,
  query?: string,
): Promise<{ album: AlbumRow; query: string; candidates: MetadataCandidate[] } | null> {
  const album = db
    .query<AlbumRow, [string]>('SELECT id, name, artist FROM library_albums WHERE id = ?')
    .get(albumId);
  if (!album) return null;
  const q = (query ?? `${album.artist} ${album.name}`).trim();
  const hits = await lidarr.album.lookup(q).catch((err) => {
    log.warn({ err, q }, 'metadata-fix lookup failed');
    return [] as LidarrAlbum[];
  });
  return { album, query: q, candidates: rankCandidates(hits, q) };
}

const VALID_TYPES: ReadonlySet<string> = new Set(['album', 'ep', 'single', 'compilation']);

export interface ApplyMetadataResult {
  albumId: string;
  artistId: string;
  artist: string;
  album: string;
  year: number | null;
  movedSongs: number;
  coverUpdated: boolean;
  releaseTypeUpdated: boolean;
}

/**
 * Apply a user-confirmed metadata correction to an album. Persists the correction
 * in `library_metadata_overrides` (so a full rescan reproduces it) and mutates the
 * canonical tables to match *immediately* — the exact rows a rescan-with-override
 * would produce.
 *
 * No files move, so `songId` is stable: songs are UPDATEd in place (curation —
 * starred/hidden — and playlist refs are preserved). Only the name-derived
 * artistId/albumId change, so we move the album row + album-keyed side tables and
 * re-derive the artist aggregates. Returns null when the album doesn't exist.
 */
export function applyMetadataFix(
  db: Database,
  albumId: string,
  input: ApplyMetadataRequest,
  opts: { coverCacheDir?: string } = {},
): ApplyMetadataResult | null {
  const cur = db
    .query<
      { id: string; name: string; artist: string; artist_id: string; year: number | null },
      [string]
    >('SELECT id, name, artist, artist_id, year FROM library_albums WHERE id = ?')
    .get(albumId);
  if (!cur) return null;

  const artist = (input.artist?.trim() || cur.artist).trim();
  const album = (input.album?.trim() || cur.name).trim();
  const year = input.year ?? cur.year ?? null;
  const releaseType: MetadataReleaseType | undefined =
    input.releaseType && VALID_TYPES.has(input.releaseType) ? input.releaseType : undefined;
  const source = input.source ?? 'manual';

  const newArtistId = artistIdFor(artist);
  const newAlbumId = albumIdFor(artist, album);
  const oldArtistId = cur.artist_id;

  // The scanner consults the override by the **raw** albumId. If the album the
  // user is correcting is itself the output of a prior correction, update that
  // existing raw-keyed row instead of creating a fresh (unreachable) one.
  const existing = findByCorrectedId(db, albumId);
  const rawAlbumId = existing ? existing.rawAlbumId : albumId;

  let coverUpdated = false;
  let releaseTypeUpdated = false;
  let movedSongs = 0;

  db.transaction(() => {
    setOverride(db, rawAlbumId, { artist, album, year: year ?? undefined }, { source });

    // Songs: id is path-derived (files don't move) → UPDATE in place, preserving
    // starred/hidden + playlist_songs references.
    movedSongs = db.run(
      'UPDATE library_songs SET artist = ?, artist_id = ?, album_id = ?, year = ? WHERE album_id = ?',
      [artist, newArtistId, newAlbumId, year, albumId],
    ).changes;

    if (newAlbumId !== albumId) {
      const collision = db
        .query<{ id: string }, [string]>('SELECT id FROM library_albums WHERE id = ?')
        .get(newAlbumId);
      if (collision) {
        // Corrected names collapse onto an album that already exists → merge: drop
        // the old row and keep the target (its aggregates are recomputed below).
        db.run('DELETE FROM library_albums WHERE id = ?', [albumId]);
        db.run('UPDATE library_albums SET name = ?, artist = ?, artist_id = ?, year = ? WHERE id = ?', [
          album,
          artist,
          newArtistId,
          year,
          newAlbumId,
        ]);
      } else {
        // Move the row to the corrected id, preserving curation columns
        // (classification/hidden/starred/manual_override/created). cover_art = id
        // by the scanner's convention.
        db.run(
          'UPDATE library_albums SET id = ?, name = ?, artist = ?, artist_id = ?, cover_art = ?, year = ? WHERE id = ?',
          [newAlbumId, album, artist, newArtistId, newAlbumId, year, albumId],
        );
      }
      repointAlbumKeyed(db, albumId, newAlbumId);
    } else {
      db.run('UPDATE library_albums SET name = ?, artist = ?, artist_id = ?, year = ? WHERE id = ?', [
        album,
        artist,
        newArtistId,
        year,
        albumId,
      ]);
    }

    // Recompute the (possibly merged) album's aggregates from its songs.
    const agg = db
      .query<
        { c: number; d: number },
        [string]
      >('SELECT COUNT(*) AS c, COALESCE(SUM(duration), 0) AS d FROM library_songs WHERE album_id = ?')
      .get(newAlbumId);
    db.run('UPDATE library_albums SET song_count = ?, duration = ? WHERE id = ?', [
      agg?.c ?? 0,
      agg?.d ?? 0,
      newAlbumId,
    ]);

    // Upsert the corrected artist (cover_art = artistId convention), refresh its
    // album_count, and prune the artist the album moved away from.
    db.run(
      `INSERT INTO library_artists (id, name, album_count, cover_art, synced_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name`,
      [newArtistId, artist, newArtistId, Date.now()],
    );
    const artistAlbums =
      db
        .query<{ c: number }, [string]>('SELECT COUNT(*) AS c FROM library_albums WHERE artist_id = ?')
        .get(newArtistId)?.c ?? 0;
    db.run('UPDATE library_artists SET album_count = ? WHERE id = ?', [artistAlbums, newArtistId]);
    if (oldArtistId && oldArtistId !== newArtistId) pruneOrphanArtist(db, oldArtistId);

    if (input.coverUrl) {
      setArtwork(db, newAlbumId, 'album', input.coverUrl, opts.coverCacheDir);
      coverUpdated = true;
    }
    if (releaseType) {
      setReleaseType(db, newAlbumId, releaseType, { canonicalTitle: album, source });
      releaseTypeUpdated = true;
    }
  })();

  log.info({ albumId, newAlbumId, artist, album, movedSongs }, 'metadata fix applied');
  return { albumId: newAlbumId, artistId: newArtistId, artist, album, year, movedSongs, coverUpdated, releaseTypeUpdated };
}

/**
 * Move album-keyed side-table rows (canonical artwork, release-type) from the old
 * albumId to the new one, deleting the stale source if the target already has a
 * row (a confirmed cover/type below overwrites it anyway).
 */
function repointAlbumKeyed(db: Database, oldId: string, newId: string): void {
  const artworkAtTarget = db.query('SELECT 1 FROM library_artwork WHERE id = ?').get(newId) !== null;
  if (artworkAtTarget) db.run('DELETE FROM library_artwork WHERE id = ?', [oldId]);
  else db.run('UPDATE library_artwork SET id = ? WHERE id = ?', [newId, oldId]);

  const metaAtTarget =
    db.query('SELECT 1 FROM library_release_meta WHERE album_id = ?').get(newId) !== null;
  if (metaAtTarget) db.run('DELETE FROM library_release_meta WHERE album_id = ?', [oldId]);
  else db.run('UPDATE library_release_meta SET album_id = ? WHERE album_id = ?', [newId, oldId]);
}
