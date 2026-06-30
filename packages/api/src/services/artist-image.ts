import type { Database } from 'bun:sqlite';
import type { Lidarr, LidarrArtist } from '@nicotind/lidarr-client';
import { pickArtistImage } from './artwork-store.js';

/**
 * Artist-portrait resolution shared by the manual artwork backfill
 * ({@link ../artwork-backfill}) and the windowed `artist-image` enrichment task.
 *
 * Both need the same "library artist → real photo URL" mapping: a Lidarr
 * `poster` first (Lidarr aggregates fanart/TADB/MusicBrainz upstream), then a
 * Spotify portrait as a fallback. Keeping it here means there's one resolution
 * path, not two that drift. The audio files themselves carry no artist image, so
 * the URL lands in `library_artwork (kind='artist')` and is served by
 * `/api/cover/:artistId`.
 */

/** Loose name match (lowercase, strip punctuation) for artist resolution. */
export function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Lidarr surface needed to resolve an artist photo — narrowed so tests inject a mock. */
export type ArtistImageLidarr = Pick<Lidarr, 'artist'>;

/**
 * Lidarr's monitored artists, fetched + indexed once so a batch resolves N
 * library artists with a single `artist.list()` call (not one per artist).
 */
export interface LidarrArtistIndex {
  monitored: LidarrArtist[];
  byName: Map<string, LidarrArtist>;
}

/** Build a {@link LidarrArtistIndex} from a pre-fetched monitored list. */
export function indexLidarrArtists(monitored: LidarrArtist[]): LidarrArtistIndex {
  return { monitored, byName: new Map(monitored.map((a) => [normalizeName(a.artistName), a])) };
}

/**
 * Find the Lidarr artist for a library artist: discography-link id → monitored
 * by name → (opt-in) a read-only `artist.lookup`. `lookupMissing` is the slow,
 * MusicBrainz-backed per-artist path, so callers keep it off for bulk runs.
 */
export async function findLidarrArtist(
  db: Database,
  lidarr: ArtistImageLidarr,
  index: LidarrArtistIndex,
  artist: { id: string; name: string },
  opts: { lookupMissing?: boolean } = {},
): Promise<LidarrArtist | undefined> {
  const link = db
    .query<
      { lidarr_id: number | null },
      [string]
    >('SELECT lidarr_id FROM artist_discography_links WHERE artist_id = ?')
    .get(artist.id);
  let found =
    (link?.lidarr_id != null ? index.monitored.find((a) => a.id === link.lidarr_id) : undefined) ??
    index.byName.get(normalizeName(artist.name));

  if (!found && opts.lookupMissing) {
    const hits = await lidarr.artist.lookup(artist.name).catch(() => []);
    found =
      hits.find((a) => normalizeName(a.artistName) === normalizeName(artist.name)) ?? hits[0];
  }
  return found;
}

/** Source a resolved artist image came from — surfaced in enrichment labels. */
export type ArtistImageSource = 'lidarr' | 'spotify';

export interface ResolvedArtistImage {
  url: string;
  source: ArtistImageSource;
}

/**
 * Resolve a real portrait URL for one library artist: Lidarr poster first, then
 * a Spotify portrait. Returns null when neither source has an image (the artist
 * keeps the neutral placeholder). `index` is required to use the Lidarr lane;
 * pass `spotifyLookup: null` to disable the Spotify fallback.
 */
export async function resolveArtistImageUrl(
  db: Database,
  deps: {
    lidarr: ArtistImageLidarr | null;
    index: LidarrArtistIndex | null;
    spotifyLookup: ((name: string) => Promise<string | null>) | null;
    lookupMissing?: boolean;
  },
  artist: { id: string; name: string },
): Promise<ResolvedArtistImage | null> {
  if (deps.lidarr && deps.index) {
    const la = await findLidarrArtist(db, deps.lidarr, deps.index, artist, {
      lookupMissing: deps.lookupMissing,
    });
    const img = pickArtistImage(la?.images);
    if (img) return { url: img, source: 'lidarr' };
  }
  if (deps.spotifyLookup) {
    const img = await deps.spotifyLookup(artist.name);
    if (img) return { url: img, source: 'spotify' };
  }
  return null;
}
