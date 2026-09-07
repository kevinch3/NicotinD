import type { Album, DiscographyAlbum } from '../services/api/api-types';

/**
 * One album grid per artist tab.
 *
 * The artist page used to render the same albums twice: the library grid, then a
 * separate "Full Discography" section repeating every release with its own covers
 * and status badges. Reading "do I have this whole album?" meant cross-referencing
 * two grids. These tiles are the join, done once.
 *
 * The join key is `DiscographyAlbum.localAlbumId` — the server's own
 * `normalizeForGrouping` match (`discography.service.ts`). The web deliberately
 * does **not** re-derive it: three separate ASCII-only normalizer copies shipped as
 * three separate bugs (#662/#706/#715), which is why `check:shared-helpers` guards
 * the family. When the server's match misses, an album renders twice — once owned,
 * once missing. That is today's behaviour made visible rather than a new defect;
 * the real fix is the one-album-identity resolver tracked in `docs/album-hunt.md`.
 */

export type AlbumTileStatus = 'owned' | 'partial' | 'missing';

export interface AlbumTile {
  /** Stable `@for` track key. Local id when owned, `mb:<lidarrId>` when missing. */
  key: string;
  title: string;
  year: number | null;
  status: AlbumTileStatus;
  /** Set for owned + partial — the tile navigates to the album page. */
  localAlbumId?: string;
  /** Local cover hash, resolved as `/api/cover/<hash>`. Wins over `coverArtUrl`. */
  coverArt?: string;
  /** Remote Lidarr/MusicBrainz cover URL — the only art a missing tile has. */
  coverArtUrl?: string;
  localTrackCount?: number;
  totalTracks?: number;
  /** The discography row behind an actionable tile; the hunt needs its `lidarrId`. */
  source?: DiscographyAlbum;
  /** A release we do not own that is not a primary studio release — collapsed. */
  secondary: boolean;
  /** 'EP' | 'Single' on the singles tab. */
  kind?: string;
}

export type AlbumTileTab = 'albums' | 'singles';

/**
 * Release types that are real records but not what someone means by "the
 * discography". Only ever applied to releases we do NOT own — an album already in
 * the library always keeps its tile, whatever Lidarr calls it.
 */
const SECONDARY_TYPES = new Set([
  'live',
  'compilation',
  'remix',
  'demo',
  'soundtrack',
  'mixtape/street',
  'mixtape',
  'dj-mix',
  'interview',
  'audiobook',
  'audio drama',
  'spokenword',
]);

const PRIMARY_ALBUM_TYPES = new Set(['album', 'ep', 'single']);

/** Which tab a release we do not own belongs to. Owned tiles follow their local row. */
function tabForType(albumType: string): AlbumTileTab {
  const t = albumType.toLowerCase();
  return t === 'ep' || t === 'single' ? 'singles' : 'albums';
}

function isSecondary(entry: DiscographyAlbum): boolean {
  if (entry.secondaryTypes.some((t) => SECONDARY_TYPES.has(t.toLowerCase()))) return true;
  return !PRIMARY_ALBUM_TYPES.has((entry.albumType ?? '').toLowerCase());
}

/** The four-digit year of an ISO release date, or null when Lidarr has none. */
export function releaseYear(releaseDate: string | undefined): number | null {
  const year = Number(releaseDate?.slice(0, 4));
  return Number.isFinite(year) && year > 0 ? year : null;
}

function localKind(album: Album): string | undefined {
  if (album.classification === 'ep') return 'EP';
  if (album.classification === 'single') return 'Single';
  return undefined;
}

function tileFromLocal(album: Album): AlbumTile {
  return {
    key: album.id,
    title: album.name,
    year: album.year ?? null,
    status: 'owned',
    localAlbumId: album.id,
    coverArt: album.coverArt,
    secondary: false,
    kind: localKind(album),
  };
}

/**
 * Merge the library's albums with the artist's full discography into one ordered
 * grid: newest first, owned and missing interleaved, so the gaps read in place.
 *
 * `local` is already the tab's own slice (`albums()` or `singlesAndEps()`), so an
 * album you own stays in the tab its local classification puts it in — Lidarr
 * calling it an EP never moves a tile out from under the user.
 */
export function buildArtistAlbumTiles(
  local: Album[],
  discography: DiscographyAlbum[],
  opts: { tab: AlbumTileTab },
): AlbumTile[] {
  const localById = new Map(local.map((a) => [a.id, a]));
  const claimed = new Set<string>();
  const tiles: AlbumTile[] = [];

  for (const entry of discography) {
    const owned = entry.localAlbumId ? localById.get(entry.localAlbumId) : undefined;

    if (owned) {
      // A matched release belongs to the tab its LOCAL row is in; an entry whose
      // local album lives in the other tab is that tab's business, not ours.
      claimed.add(owned.id);
      tiles.push({
        key: owned.id,
        title: owned.name,
        year: owned.year ?? releaseYear(entry.releaseDate),
        status: entry.status === 'present' ? 'owned' : 'partial',
        localAlbumId: owned.id,
        coverArt: owned.coverArt,
        coverArtUrl: entry.coverArtUrl,
        localTrackCount: entry.localTrackCount,
        totalTracks: entry.totalTracks,
        // A complete album needs no action, so it carries no hunt source.
        source: entry.status === 'present' ? undefined : entry,
        secondary: false,
        kind: localKind(owned),
      });
      continue;
    }

    // Not ours. `localAlbumId` set but absent from this tab's list means the
    // match landed in the other tab — skip it rather than duplicating it here.
    if (entry.localAlbumId) continue;
    if (tabForType(entry.albumType) !== opts.tab) continue;

    tiles.push({
      key: `mb:${entry.lidarrId}`,
      title: entry.title,
      year: releaseYear(entry.releaseDate),
      status: 'missing',
      coverArtUrl: entry.coverArtUrl,
      totalTracks: entry.totalTracks,
      source: entry,
      secondary: isSecondary(entry),
      kind: opts.tab === 'singles' ? entry.albumType : undefined,
    });
  }

  // Albums the discography never mentioned — bootlegs, mis-split discs, anything
  // Lidarr's metadata profile omits. They are in the library, so they get a tile.
  for (const album of local) {
    if (!claimed.has(album.id)) tiles.push(tileFromLocal(album));
  }

  return sortTiles(tiles);
}

/** Newest first; undated releases last; title breaks a tie so the order is stable. */
export function sortTiles(tiles: AlbumTile[]): AlbumTile[] {
  return [...tiles].sort((a, b) => {
    if (a.year !== b.year) {
      if (a.year === null) return 1;
      if (b.year === null) return -1;
      return b.year - a.year;
    }
    return a.title.localeCompare(b.title);
  });
}

/** The tiles shown by default, and the collapsed tail behind "Show all releases". */
export function partitionTiles(tiles: AlbumTile[]): {
  primary: AlbumTile[];
  secondary: AlbumTile[];
} {
  return {
    primary: tiles.filter((t) => !t.secondary),
    secondary: tiles.filter((t) => t.secondary),
  };
}
