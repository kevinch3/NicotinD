import type { Lidarr, LidarrAlbum, LidarrArtist } from '@nicotind/lidarr-client';
import { createLogger, NicotinDError } from '@nicotind/core';
import { addArtistFromLookup } from './lidarr-provision.js';
import { normalizeTitle } from './album-hunter.service.js';

const log = createLogger('catalog');

export interface CatalogArtist {
  mbid: string;
  name: string;
  imageUrl?: string;
  type?: string;
}

export interface CatalogAlbum {
  foreignAlbumId: string; // MusicBrainz release-group ID
  title: string;
  artistName: string;
  artistMbid: string;
  year?: string;
  albumType: string;
  secondaryTypes: string[];
  coverUrl?: string;
  trackCount: number;
}

export interface CatalogSearchResult {
  artists: CatalogArtist[];
  albums: CatalogAlbum[];
}

export interface ResolveAlbumInput {
  foreignAlbumId: string;
  artistMbid: string;
  artistName: string;
  albumTitle: string;
}

export interface ResolveAlbumResult {
  lidarrAlbumId: number;
  totalTracks: number;
  title: string;
  artistName: string;
}

/**
 * Bridges free-text search to the album-hunt flow via Lidarr/MusicBrainz.
 *
 * `search()` is a read-only metadata lookup (no Lidarr mutation). `resolveAlbum()`
 * is the add-on-demand step: it ensures the artist exists in Lidarr (adding it
 * from a MusicBrainz lookup if needed), then returns the *real* Lidarr album id so
 * the existing `/api/discography/albums/:id/hunt` flow — which scores Soulseek
 * folders against Lidarr's canonical tracklist — can run unchanged.
 */
export class CatalogService {
  constructor(
    private lidarr: Lidarr,
    private musicDir?: string,
  ) {}

  async search(query: string): Promise<CatalogSearchResult> {
    const [artistHits, albumHits] = await Promise.all([
      this.lidarr.artist.lookup(query).catch((err) => {
        log.warn({ err }, 'Artist lookup failed');
        return [] as LidarrArtist[];
      }),
      this.lidarr.album.lookup(query).catch((err) => {
        log.warn({ err }, 'Album lookup failed');
        return [] as LidarrAlbum[];
      }),
    ]);

    // Dedupe artist pills by normalized name: a query like "Zara" returns the
    // same display name many times (distinct MBIDs, different casing — "Zara",
    // "ZarA", …), but every pill just re-searches that name, so collapsing them
    // keeps the row useful. See docs/e2e-playground-findings-2026-06.md §A4.
    const artists: CatalogArtist[] = [];
    const seenArtist = new Set<string>();
    for (const a of artistHits.map(mapArtist)) {
      const key = normalizeName(a.name);
      if (!key || seenArtist.has(key)) continue;
      seenArtist.add(key);
      artists.push(a);
    }

    // Scope the album cards to the matched artist(s) when their *own* releases
    // are present. The global `album.lookup` ranks anything whose title contains
    // the query (mashups, tributes, compilations by unrelated artists) above the
    // artist's actual discography — useless for non-distinctive names. When none
    // of the albums belong to a returned artist (e.g. a pure album-title search),
    // we keep them all so the lane never goes empty. See §A1.
    const artistNameSet = new Set(artists.map((a) => normalizeName(a.name)));
    const allAlbums = albumHits.map(mapAlbum);
    const ownAlbums = allAlbums.filter((a) => artistNameSet.has(normalizeName(a.artistName)));

    return {
      artists,
      albums: ownAlbums.length > 0 ? ownAlbums : allAlbums,
    };
  }

  async resolveAlbum(input: ResolveAlbumInput): Promise<ResolveAlbumResult> {
    const lidarrArtistId = await this.resolveOrAddArtist(input.artistMbid, input.artistName);

    const albums = await this.lidarr.album.listByArtist(lidarrArtistId);
    // The album cards come from the *global* `album.lookup`, whose MusicBrainz
    // release-group IDs aren't guaranteed to appear in this artist's Lidarr
    // discography (compilations / "best of" / vol.N collections especially), so
    // an id-only match 500s on perfectly valid cards. Fall back to a
    // normalized-title match (diacritic-insensitive — Latin-American-heavy
    // library) before giving up. See docs/e2e-playground-findings-2026-06.md §A2.
    const album =
      albums.find((a) => a.foreignAlbumId === input.foreignAlbumId) ??
      (input.albumTitle
        ? albums.find((a) => normalizeTitle(a.title) === normalizeTitle(input.albumTitle))
        : undefined);
    if (!album) {
      throw new NicotinDError(
        `"${input.albumTitle}" isn't in ${input.artistName}'s Lidarr discography yet`,
        'ALBUM_NOT_IN_LIDARR',
        404,
      );
    }

    return {
      lidarrAlbumId: album.id,
      totalTracks: album.statistics?.totalTrackCount ?? 0,
      title: album.title,
      artistName: input.artistName,
    };
  }

  private async resolveOrAddArtist(artistMbid: string, artistName: string): Promise<number> {
    const monitored = await this.lidarr.artist.list();
    const existing = monitored.find(
      (a) =>
        a.foreignArtistId === artistMbid ||
        normalizeName(a.artistName) === normalizeName(artistName),
    );
    if (existing) return existing.id;

    log.info({ artistMbid, artistName }, 'Adding artist to Lidarr for catalog hunt');

    const candidates = await this.lidarr.artist.lookup(artistName);
    const best = candidates.find((a) => a.foreignArtistId === artistMbid) ?? candidates[0];
    if (!best) throw new Error(`Lidarr found no artist matching "${artistName}"`);

    const added = await addArtistFromLookup(this.lidarr, best, this.musicDir);
    return added.id;
  }
}

function mapArtist(a: LidarrArtist): CatalogArtist {
  const image = a.images?.find((i) => i.coverType === 'poster') ?? a.images?.[0];
  return {
    mbid: a.foreignArtistId,
    name: a.artistName,
    imageUrl: image?.remoteUrl ?? image?.url,
    type: a.status,
  };
}

function mapAlbum(a: LidarrAlbum): CatalogAlbum {
  const cover = a.images?.find((i) => i.coverType === 'cover') ?? a.images?.[0];
  // Lidarr lookup payloads omit per-track titles but carry release track counts;
  // take the largest so a deluxe/expanded release doesn't under-report.
  const trackCount =
    a.releases?.reduce((max, r) => Math.max(max, r.trackCount ?? 0), 0) ??
    a.statistics?.totalTrackCount ??
    0;
  return {
    foreignAlbumId: a.foreignAlbumId,
    title: a.title,
    artistName: a.artist?.artistName ?? '',
    artistMbid: a.artist?.foreignArtistId ?? '',
    year: plausibleYear(a.releaseDate),
    albumType: a.albumType,
    secondaryTypes: a.secondaryTypes ?? [],
    coverUrl: cover?.remoteUrl ?? cover?.url,
    trackCount,
  };
}

/**
 * Extract a display year, dropping implausible placeholder dates. Lidarr/
 * MusicBrainz returns `0001-01-01` (and other pre-recording-era dates) for
 * release groups with no real date, which would otherwise render as "0001" on
 * the album card. See docs/e2e-playground-findings-2026-06.md §A3.
 */
function plausibleYear(releaseDate?: string): string | undefined {
  if (!releaseDate) return undefined;
  const year = Number(releaseDate.slice(0, 4));
  return Number.isFinite(year) && year >= 1900 ? String(year) : undefined;
}

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
