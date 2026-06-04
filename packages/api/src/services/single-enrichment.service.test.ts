import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { SingleEnrichmentService } from './single-enrichment.service.js';
import { getReleaseType } from './release-meta-store.js';
import { resolveArtwork } from './artwork-store.js';
import type { CatalogService, CatalogSearchResult } from './catalog-search.service.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

/** Minimal CatalogService stub returning a canned lookup result. */
function makeCatalog(result: CatalogSearchResult): CatalogService {
  return { search: async () => result } as unknown as CatalogService;
}

function throwingCatalog(): CatalogService {
  return {
    search: async () => {
      throw new Error('lidarr down');
    },
  } as unknown as CatalogService;
}

function seedSingle(opts: {
  albumId: string;
  artistId: string;
  name: string;
  artist: string;
  path: string;
  classification?: string;
}): void {
  db.run(
    `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
     VALUES (?, ?, ?, ?, 1, 0, ?, 1)`,
    [opts.albumId, opts.name, opts.artist, opts.artistId, opts.classification ?? 'single'],
  );
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, synced_at)
     VALUES (?, ?, ?, ?, ?, 0, ?, 1)`,
    [`song-${opts.albumId}`, opts.albumId, opts.name, opts.artist, opts.artistId, opts.path],
  );
}

const PATH = 'Alfredo Casero/Singles/Mi Cancion.mp3';

describe('SingleEnrichmentService', () => {
  it('writes release type + album & artist artwork on a lookup hit', async () => {
    seedSingle({
      albumId: 'alb-1',
      artistId: 'art-1',
      name: 'Mi Cancion',
      artist: 'Alfredo Casero',
      path: PATH,
    });
    const catalog = makeCatalog({
      artists: [{ mbid: 'm1', name: 'Alfredo Casero', imageUrl: 'https://x/artist.jpg' }],
      albums: [
        {
          foreignAlbumId: 'fa1',
          title: 'Mi Cancion',
          artistName: 'Alfredo Casero',
          artistMbid: 'm1',
          albumType: 'Single',
          secondaryTypes: [],
          coverUrl: 'https://x/cover.jpg',
          trackCount: 1,
        },
      ],
    });

    await new SingleEnrichmentService({ db, catalog }).enrich([PATH]);

    expect(getReleaseType(db, 'alb-1')).toBe('single');
    expect(resolveArtwork(db, 'alb-1')).toEqual({ url: 'https://x/cover.jpg', key: 'alb-1' });
    expect(resolveArtwork(db, 'art-1')).toEqual({ url: 'https://x/artist.jpg', key: 'art-1' });
  });

  it('maps an EP album type to ep', async () => {
    seedSingle({ albumId: 'alb-1', artistId: 'art-1', name: 'My EP', artist: 'A', path: PATH });
    const catalog = makeCatalog({
      artists: [],
      albums: [
        {
          foreignAlbumId: 'fa',
          title: 'My EP',
          artistName: 'A',
          artistMbid: 'm',
          albumType: 'EP',
          secondaryTypes: [],
          trackCount: 4,
        },
      ],
    });
    await new SingleEnrichmentService({ db, catalog }).enrich([PATH]);
    expect(getReleaseType(db, 'alb-1')).toBe('ep');
  });

  it('degrades gracefully when the lookup throws (Lidarr down)', async () => {
    seedSingle({
      albumId: 'alb-1',
      artistId: 'art-1',
      name: 'Mi Cancion',
      artist: 'Alfredo Casero',
      path: PATH,
    });
    await new SingleEnrichmentService({ db, catalog: throwingCatalog() }).enrich([PATH]);
    expect(getReleaseType(db, 'alb-1')).toBeNull(); // nothing written, no throw
  });

  it('writes nothing when there is no matching album', async () => {
    seedSingle({
      albumId: 'alb-1',
      artistId: 'art-1',
      name: 'Mi Cancion',
      artist: 'Alfredo Casero',
      path: PATH,
    });
    const catalog = makeCatalog({
      artists: [],
      albums: [
        {
          foreignAlbumId: 'fa',
          title: 'Totally Different',
          artistName: 'Someone Else',
          artistMbid: 'm',
          albumType: 'Single',
          secondaryTypes: [],
          trackCount: 1,
        },
      ],
    });
    await new SingleEnrichmentService({ db, catalog }).enrich([PATH]);
    expect(getReleaseType(db, 'alb-1')).toBeNull();
  });

  it('skips full-length albums (only loose single/ep/unknown rows are enriched)', async () => {
    seedSingle({
      albumId: 'alb-1',
      artistId: 'art-1',
      name: 'Real Album',
      artist: 'A',
      path: PATH,
      classification: 'album',
    });
    const catalog = makeCatalog({
      artists: [],
      albums: [
        {
          foreignAlbumId: 'fa',
          title: 'Real Album',
          artistName: 'A',
          artistMbid: 'm',
          albumType: 'Single',
          secondaryTypes: [],
          trackCount: 1,
        },
      ],
    });
    await new SingleEnrichmentService({ db, catalog }).enrich([PATH]);
    expect(getReleaseType(db, 'alb-1')).toBeNull();
  });
});
