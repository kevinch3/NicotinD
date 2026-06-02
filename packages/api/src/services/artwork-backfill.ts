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

/** Lidarr surface the backfill needs — narrowed so tests can inject a mock. */
export type BackfillLidarr = Pick<Lidarr, 'artist' | 'album'>;

/** Loose name match (lowercase, strip punctuation) for artist resolution. */
function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Populate `library_artwork` for albums/artists already in the library by
 * matching them to Lidarr. Artists resolve via `artist_discography_links` or by
 * name (monitored list, then a read-only lookup); albums resolve by edition-
 * stripped group key against `listByArtist`. Idempotent and safe to re-run; with
 * `apply: false` it reports counts without writing.
 */
export async function backfillArtwork(
  db: Database,
  lidarr: BackfillLidarr,
  opts: { apply: boolean; coverCacheDir?: string },
): Promise<BackfillArtworkResult> {
  const result: BackfillArtworkResult = {
    artistsMatched: 0,
    artistsUnresolved: 0,
    albumsMatched: 0,
    albumsUnresolved: 0,
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

    if (!lidarrArtist) {
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

  return result;
}
