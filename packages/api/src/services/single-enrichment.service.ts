import type { Database } from 'bun:sqlite';
import { createLogger } from '@nicotind/core';
import type { CatalogService, CatalogAlbum } from './catalog-search.service.js';
import { setReleaseType, mapLidarrAlbumType } from './release-meta-store.js';
import { setArtwork } from './artwork-store.js';

const log = createLogger('single-enrichment');

interface LooseAlbumRow {
  id: string;
  name: string;
  artist: string;
  artist_id: string;
  classification: string;
}

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function titlesMatch(a: string, b: string): boolean {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/**
 * Ingest-time release-type + artwork enrichment for loose singles/EPs.
 *
 * When a URL acquisition (yt-dlp / spotdl) lands an album-less track, the scanner
 * turns it into its own single release classified by track-count heuristic. This
 * service does a best-effort Lidarr/MusicBrainz lookup to attach the *authoritative*
 * release type (single vs EP) plus canonical cover/artist artwork, writing the
 * side tables (`library_release_meta`, `library_artwork`) keyed on the scanner's
 * deterministic ids — exactly like the hunt flow writes artwork before a scan.
 *
 * It degrades gracefully: any failure (Lidarr unconfigured, lookup error, no
 * match) is swallowed and the heuristic classification + on-disk art stand. The
 * caller reclassifies afterwards so the written metadata takes effect.
 */
export class SingleEnrichmentService {
  constructor(
    private opts: { db: Database; catalog: CatalogService; coverCacheDir?: string },
  ) {}

  /** Best-effort enrichment of the loose single/EP albums touched by `relPaths`. */
  async enrich(relPaths: string[]): Promise<void> {
    if (relPaths.length === 0) return;
    const { db } = this.opts;

    // Only the just-scanned albums that are loose (single/ep/unknown). Full-length
    // albums are left to the hunt flow / existing artwork backfill.
    const placeholders = relPaths.map(() => '?').join(',');
    const rows = db
      .query<LooseAlbumRow, string[]>(
        `SELECT DISTINCT a.id, a.name, a.artist, a.artist_id, a.classification
         FROM library_songs s JOIN library_albums a ON a.id = s.album_id
         WHERE s.path IN (${placeholders})
           AND a.classification IN ('single','ep','unknown')`,
      )
      .all(...relPaths);

    for (const row of rows) {
      try {
        await this.enrichAlbum(row);
      } catch (err) {
        log.debug({ err, album: row.name }, 'Single enrichment skipped (lookup failed)');
      }
    }
  }

  private async enrichAlbum(row: LooseAlbumRow): Promise<void> {
    const { db, catalog, coverCacheDir } = this.opts;
    const result = await catalog.search(`${row.artist} ${row.name}`);

    const album = pickBestAlbum(result.albums, row.artist, row.name);
    if (!album) return;

    const type = mapLidarrAlbumType(album.albumType);
    if (type) {
      setReleaseType(db, row.id, type, { canonicalTitle: album.title, source: 'lidarr' });
    }
    if (album.coverUrl) {
      setArtwork(db, row.id, 'album', album.coverUrl, coverCacheDir);
    }

    // Artist photo (audio files carry none) — match the catalog artist by name.
    const artist = result.artists.find((a) => titlesMatch(a.name, row.artist));
    if (artist?.imageUrl) {
      setArtwork(db, row.artist_id, 'artist', artist.imageUrl, coverCacheDir);
    }

    log.info({ album: row.name, artist: row.artist, type: type ?? 'unmapped' }, 'Enriched loose single/EP');
  }
}

/** Closest album hit: same artist, and title matching the loose track title. */
function pickBestAlbum(
  albums: CatalogAlbum[],
  artist: string,
  title: string,
): CatalogAlbum | undefined {
  const byArtist = albums.filter((a) => titlesMatch(a.artistName, artist));
  return (
    byArtist.find((a) => titlesMatch(a.title, title)) ??
    albums.find((a) => titlesMatch(a.artistName, artist) && titlesMatch(a.title, title))
  );
}
