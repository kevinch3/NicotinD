import type { Database } from 'bun:sqlite';
import type { Lidarr } from '@nicotind/lidarr-client';
import { createLogger } from '@nicotind/core';
import { normalizeForGrouping } from './album-grouping.js';
import { setArtwork, pickAlbumCover, pickArtistImage } from './artwork-store.js';

const log = createLogger('artwork-backfill');

export interface BackfillArtworkResult {
  artistsMatched: number;
  artistsUnresolved: number;
  albumsMatched: number;
  albumsUnresolved: number;
  /** Albums attempted via the targeted per-album MusicBrainz lookup pass. */
  albumsLookedUp: number;
  /** Of those, how many got a cover (and possibly an artist poster). */
  albumLookupMatched: number;
}

/**
 * Album/artist names that aren't a real release — "Singles" catch-all folders,
 * Various-Artists compilations, unknowns. The per-album lookup skips these: they
 * never match a canonical MusicBrainz release-group, so a lookup is wasted (or
 * worse, returns a wrong-match cover).
 */
function looksLikeNonAlbum(albumName: string, artist: string): boolean {
  const a = normalizeForGrouping(albumName);
  const ar = normalizeName(artist);
  return (
    a === 'singles' ||
    a === 'unknown' ||
    a === 'unknown album' ||
    a === '' ||
    ar === 'various artists' ||
    ar === 'va' ||
    ar === 'various' ||
    ar === 'unknown artist'
  );
}

interface ArtistRow {
  id: string;
  name: string;
}
interface AlbumRow {
  id: string;
  name: string;
  artist_id: string;
}
interface AlbumLookupRow {
  id: string;
  name: string;
  artist: string;
  artist_id: string;
}

/** Lidarr surface the backfill needs — narrowed so tests can inject a mock. */
export type BackfillLidarr = Pick<Lidarr, 'artist' | 'album'>;

/** Loose name match (lowercase, strip punctuation) for artist resolution. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Populate `library_artwork` for albums/artists already in the library by
 * matching them to Lidarr. Artists resolve via `artist_discography_links` or by
 * name against the monitored list; albums resolve by edition-stripped group key
 * against `listByArtist`. Idempotent and safe to re-run; with `apply: false` it
 * reports counts without writing.
 *
 * `lookupMissing` (default off) additionally fires a per-artist `artist.lookup`
 * for artists not monitored in Lidarr. That's a slow MusicBrainz-backed call per
 * artist — fine for small gaps but pathological (and rate-limit-risky) on a large
 * library where most artists aren't monitored, so it's opt-in.
 *
 * `albumLookupMinTracks` (default off) runs a targeted second pass: for every
 * substantial album (`song_count >= N`) still missing artwork, it queries
 * `album.lookup("<artist> <album>")` directly — independent of whether the artist
 * is monitored — and stores the matched release-group's cover (plus the artist
 * poster from the same payload). Junk groupings (Singles/Various Artists) are
 * skipped. Bounded by the number of substantial uncovered albums, so it's cheap
 * even on a big library where the per-artist lookup would not be.
 */
export async function backfillArtwork(
  db: Database,
  lidarr: BackfillLidarr,
  opts: {
    apply: boolean;
    coverCacheDir?: string;
    lookupMissing?: boolean;
    albumLookupMinTracks?: number;
  },
): Promise<BackfillArtworkResult> {
  const result: BackfillArtworkResult = {
    artistsMatched: 0,
    artistsUnresolved: 0,
    albumsMatched: 0,
    albumsUnresolved: 0,
    albumsLookedUp: 0,
    albumLookupMatched: 0,
  };

  const artists = db.query<ArtistRow, []>('SELECT id, name FROM library_artists').all();
  const albums = db
    .query<AlbumRow, []>('SELECT id, name, artist_id FROM library_albums')
    .all();
  const albumsByArtist = new Map<string, AlbumRow[]>();
  for (const a of albums) {
    const list = albumsByArtist.get(a.artist_id) ?? [];
    list.push(a);
    albumsByArtist.set(a.artist_id, list);
  }

  const monitored = await lidarr.artist.list().catch((err) => {
    log.warn({ err }, 'Lidarr artist.list failed');
    return [];
  });
  const monitoredByName = new Map(monitored.map((a) => [normalizeName(a.artistName), a]));

  for (const artist of artists) {
    // Resolve the Lidarr artist: discography link → monitored by name → lookup.
    const link = db
      .query<{ lidarr_id: number | null }, [string]>(
        'SELECT lidarr_id FROM artist_discography_links WHERE artist_id = ?',
      )
      .get(artist.id);
    let lidarrArtist =
      (link?.lidarr_id != null ? monitored.find((a) => a.id === link.lidarr_id) : undefined) ??
      monitoredByName.get(normalizeName(artist.name));

    if (!lidarrArtist && opts.lookupMissing) {
      const hits = await lidarr.artist.lookup(artist.name).catch(() => []);
      lidarrArtist =
        hits.find((a) => normalizeName(a.artistName) === normalizeName(artist.name)) ?? hits[0];
    }

    if (!lidarrArtist) {
      result.artistsUnresolved += 1;
      continue;
    }

    const image = pickArtistImage(lidarrArtist.images);
    if (image) {
      if (opts.apply) setArtwork(db, artist.id, 'artist', image, opts.coverCacheDir);
      result.artistsMatched += 1;
    } else {
      result.artistsUnresolved += 1;
    }

    // Albums: only resolvable for monitored artists (need a Lidarr id to list).
    const libraryAlbums = albumsByArtist.get(artist.id) ?? [];
    if (libraryAlbums.length === 0 || lidarrArtist.id == null) {
      result.albumsUnresolved += libraryAlbums.length;
      continue;
    }
    const lidarrAlbums = await lidarr.album.listByArtist(lidarrArtist.id).catch(() => []);
    const coverByKey = new Map<string, string>();
    for (const la of lidarrAlbums) {
      const cover = pickAlbumCover(la.images);
      if (cover) coverByKey.set(normalizeForGrouping(la.title), cover);
    }
    for (const album of libraryAlbums) {
      const cover = coverByKey.get(normalizeForGrouping(album.name));
      if (cover) {
        if (opts.apply) setArtwork(db, album.id, 'album', cover, opts.coverCacheDir);
        result.albumsMatched += 1;
      } else {
        result.albumsUnresolved += 1;
      }
    }
  }

  // Targeted pass: substantial albums still missing artwork, looked up directly
  // by "<artist> <album>" so we don't depend on the artist being monitored.
  if (opts.albumLookupMinTracks != null) {
    const candidates = db
      .query<AlbumLookupRow, [number]>(
        `SELECT id, name, artist, artist_id FROM library_albums
         WHERE song_count >= ?
           AND NOT EXISTS (SELECT 1 FROM library_artwork w WHERE w.id = library_albums.id AND w.kind = 'album')`,
      )
      .all(opts.albumLookupMinTracks);

    for (const album of candidates) {
      if (looksLikeNonAlbum(album.name, album.artist)) continue;
      result.albumsLookedUp += 1;

      const hits = await lidarr.album
        .lookup(`${album.artist} ${album.name}`)
        .catch(() => []);
      const wantTitle = normalizeForGrouping(album.name);
      const wantArtist = normalizeName(album.artist);
      const match = hits.find(
        (h) =>
          normalizeForGrouping(h.title) === wantTitle &&
          (!h.artist?.artistName || normalizeName(h.artist.artistName) === wantArtist),
      );
      if (!match) continue;

      const cover = pickAlbumCover(match.images);
      if (!cover) continue;
      if (opts.apply) setArtwork(db, album.id, 'album', cover, opts.coverCacheDir);
      result.albumLookupMatched += 1;

      // Opportunistically fill the artist poster from the same payload (the
      // library artist_id is sha1(normalizeArtistForGrouping(artist)), matching the
      // album row's artist_id) when we don't already have one.
      const poster = pickArtistImage(match.artist?.images);
      if (
        poster &&
        !db
          .query<{ id: string }, [string]>(
            `SELECT id FROM library_artwork WHERE id = ? AND kind = 'artist'`,
          )
          .get(album.artist_id)
      ) {
        if (opts.apply) setArtwork(db, album.artist_id, 'artist', poster, opts.coverCacheDir);
        result.artistsMatched += 1;
      }
    }
  }

  return result;
}
