import type { Lidarr, LidarrAlbum, LidarrArtist } from '@nicotind/lidarr-client';
import { createLogger, NicotinDError } from '@nicotind/core';
import { addArtistFromLookup } from './lidarr-provision.js';
import { normalizeTitle } from './album-hunter.service.js';
import { tokenize, matchesAllTokens } from './search-tokens.js';

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
  /** The artist the album cards were scoped to, when the query named one. */
  scopedArtist?: string;
  /**
   * True when the query confidently matched an artist but the global
   * `album.lookup` carried none of *their* releases (only mashups/tributes that
   * merely mention them). We return an empty `albums` rather than that junk — the
   * UI should fall back to the network lane. See §A6.
   */
  discographyUnavailable?: boolean;
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
    // artist's actual discography — useless for non-distinctive names. See §A1.
    const artistNameSet = new Set(artists.map((a) => normalizeName(a.name)));
    const allAlbums = albumHits.map(mapAlbum);
    const ownAlbums = rankAlbums(
      allAlbums.filter((a) => artistNameSet.has(normalizeName(a.artistName))),
    );

    // Did the query itself name an artist? (exact normalized match — conservative
    // so an ambiguous one-word query doesn't suppress legitimate title hits.)
    const normQuery = normalizeName(query);
    const matchedArtist = artists.find((a) => normalizeName(a.name) === normQuery);

    if (ownAlbums.length > 0) {
      // Real discography found — show it (junk already filtered out).
      return { artists, albums: ownAlbums, scopedArtist: matchedArtist?.name };
    }
    if (matchedArtist) {
      // Artist named, but the lookup surfaced none of their albums (e.g. Zara
      // Larsson). Suppress the mashup/tribute junk and flag so the UI promotes
      // the network lane instead of rendering cards that all 404 on resolve. §A6.
      return {
        artists,
        albums: [],
        scopedArtist: matchedArtist.name,
        discographyUnavailable: true,
      };
    }
    // No artist named (pure album-title search). Lidarr's free-text `album.lookup`
    // ranks anything whose title *fuzzily* matches, so for a multi-word query with
    // a rare second word ("La bifurcada") it collapses to the common first token
    // and floods the grid with unrelated "La"/"Là" albums — the second word looks
    // "stripped". Keep only albums that actually contain every query token
    // (accent-insensitive, over title + artist) so the grid is relevant instead of
    // first-token noise; the network/folder lane still carries anything we drop.
    return { artists, albums: filterAlbumsByRelevance(allAlbums, query) };
  }

  /**
   * Load an artist's *real* discography on demand — the deep fix for §A6. The
   * global `album.lookup` carries none of a non-distinctive artist's own albums,
   * and Lidarr can only list an artist's albums once it's added, so this **adds
   * the artist to Lidarr** (same mutation `resolveAlbum` already makes on a hunt)
   * and returns their `listByArtist` releases as ranked catalog cards. User-
   * initiated (the web's "Load discography" button), never automatic on search.
   */
  async loadDiscography(artistMbid: string, artistName: string): Promise<CatalogSearchResult> {
    const lidarrArtistId = await this.resolveOrAddArtist(artistMbid, artistName);
    const albums = await this.lidarr.album.listByArtist(lidarrArtistId);
    const cards = rankAlbums(
      albums.map((a) => {
        const card = mapAlbum(a);
        // listByArtist payloads may omit the nested artist — backfill from input.
        return {
          ...card,
          artistName: card.artistName || artistName,
          artistMbid: card.artistMbid || artistMbid,
        };
      }),
    );
    return { artists: [], albums: cards, scopedArtist: artistName };
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

/**
 * Keep only albums whose title + artist contains **every** query token
 * (accent-insensitive, AND semantics — the same matcher the local library lane
 * uses). Applied to the pure-title-search fall-through so Lidarr's fuzzy
 * `album.lookup` can't degrade a multi-word query to its first token. An empty
 * query (no tokens) keeps everything. Exported for direct unit testing.
 */
export function filterAlbumsByRelevance(albums: CatalogAlbum[], query: string): CatalogAlbum[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return albums;
  return albums.filter((a) => matchesAllTokens(`${a.title} ${a.artistName}`, tokens));
}

/** Album-type display priority for an artist's own discography. */
const TYPE_RANK: Record<string, number> = { album: 0, ep: 1, single: 2 };

/**
 * Rank an artist's own albums for display: real (non-compilation) releases
 * first, then primary types (Album > EP > Single > others), then newest
 * first. Keeps the real discography readable instead of in raw lookup order.
 * See §A1/§A6.
 *
 * Compilations sort *after* everything else: `album.lookup`'s free-text
 * relevance ranking surfaces "Best of"/"Greatest Hits" reissues extremely
 * well (they're heavily re-tagged on MusicBrainz), often crowding out an
 * artist's real studio albums entirely from the top of the card grid — but
 * Lidarr's own `listByArtist` typically doesn't track compilations at all, so
 * a card built from one reliably 404s on resolve (`ALBUM_NOT_IN_LIDARR`,
 * §A2) and dead-ends into the raw-fallback banner. Demoting them keeps the
 * default, most-clickable cards on the releases that actually resolve,
 * without hiding compilations — they're still legitimate acquisition
 * targets via the raw fallback, just no longer the accidental default.
 */
function rankAlbums(albums: CatalogAlbum[]): CatalogAlbum[] {
  return [...albums].sort((a, b) => {
    const ca = isCompilation(a) ? 1 : 0;
    const cb = isCompilation(b) ? 1 : 0;
    if (ca !== cb) return ca - cb;
    const ra = TYPE_RANK[a.albumType?.toLowerCase()] ?? 3;
    const rb = TYPE_RANK[b.albumType?.toLowerCase()] ?? 3;
    if (ra !== rb) return ra - rb;
    return Number(b.year ?? 0) - Number(a.year ?? 0);
  });
}

function isCompilation(album: CatalogAlbum): boolean {
  return album.secondaryTypes.some((t) => t.toLowerCase() === 'compilation');
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
