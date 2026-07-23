import type { Database } from 'bun:sqlite';
import type { Lidarr, LidarrArtist } from '@nicotind/lidarr-client';

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
    .query<{ lidarr_id: number | null }, [string]>(
      'SELECT lidarr_id FROM artist_discography_links WHERE artist_id = ?',
    )
    .get(artist.id);
  let found =
    (link?.lidarr_id != null ? index.monitored.find((a) => a.id === link.lidarr_id) : undefined) ??
    index.byName.get(normalizeName(artist.name));

  if (!found && opts.lookupMissing) {
    const hits = await lidarr.artist.lookup(artist.name).catch(() => []);
    found = hits.find((a) => normalizeName(a.artistName) === normalizeName(artist.name)) ?? hits[0];
  }
  return found;
}

/**
 * Source a resolved artist image came from — surfaced in enrichment labels.
 * Open-ended (`string`, not a closed union) so a new provider brings its own
 * provenance without editing this type: the chain that produces it lives in
 * {@link ./artist-image-providers}.
 */
export type ArtistImageSource = string;

export interface ResolvedArtistImage {
  url: string;
  source: ArtistImageSource;
}

/**
 * One provider in the artist-image chain: a named source that maps a library
 * artist to a portrait URL (or null when it has none). Concrete providers
 * (Lidarr, Spotify, …) — and the priority-ordered factory that assembles them —
 * live in {@link ./artist-image-providers}; each contains its own deps (the
 * Lidarr provider closes over `db` + the monitored index, so the generic
 * resolver never sees a `db` handle).
 */
export interface ArtistImageProvider {
  /** Provenance label recorded on the resolved image (e.g. 'lidarr'). */
  source: string;
  lookup(artist: { id: string; name: string }): Promise<string | null>;
}

/**
 * Resolve a real portrait URL for one library artist by walking `providers` in
 * order and returning the first non-null hit (with its source). Returns null
 * when the whole chain comes up empty (the artist keeps the neutral
 * placeholder). Provider-agnostic: adding a source is one entry in the factory,
 * no change here.
 */
export async function resolveArtistImageUrl(
  providers: readonly ArtistImageProvider[],
  artist: { id: string; name: string },
): Promise<ResolvedArtistImage | null> {
  for (const provider of providers) {
    const url = await provider.lookup(artist);
    if (url) return { url, source: provider.source };
  }
  return null;
}
