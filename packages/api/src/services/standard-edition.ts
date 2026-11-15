import { matchFilesToTitles } from '@nicotind/core';
import type { LidarrAlbum, LidarrAlbumRelease, LidarrTrack } from '../lidarr/types.js';

/**
 * "The album" is its standard edition (#1936). Lidarr monitors the biggest box set for most
 * catalogue classics: *Monster* has 64 tracks monitored, while 23 of its 29 releases have 12. A hunt
 * scored against the box set rejected a perfect standard rip (12/64 < the 60% Get bar), and every
 * card that landed one reported the bonus discs as "not offered".
 * → docs/album-hunt.md "The standard edition is the album".
 */

/** What the tracklist helpers read from Lidarr: only the two track listings. */
export interface TracklistSource {
  track: {
    listByAlbum(albumId: number): Promise<LidarrTrack[]>;
    listByRelease(releaseId: number): Promise<LidarrTrack[]>;
  };
}

/**
 * The release that stands for the album: the most common track count among its official
 * releases, fewer tracks on a tie, and the monitored release when it has that count. Not the
 * smallest: *Seventeen Seconds* has one odd 9-track pressing among 22 of 10.
 */
export function pickStandardRelease(
  releases: readonly LidarrAlbumRelease[] | undefined,
): LidarrAlbumRelease | null {
  const usable = (releases ?? []).filter((r) => r.trackCount > 0);
  const official = usable.filter((r) => r.status?.toLowerCase() === 'official');
  const pool = official.length > 0 ? official : usable;
  if (pool.length === 0) return null;

  const frequency = new Map<number, number>();
  for (const r of pool) frequency.set(r.trackCount, (frequency.get(r.trackCount) ?? 0) + 1);
  let count = 0;
  let seen = 0;
  for (const [c, n] of frequency) {
    if (n > seen || (n === seen && c < count)) {
      count = c;
      seen = n;
    }
  }
  const atCount = pool.filter((r) => r.trackCount === count);
  return atCount.find((r) => r.monitored) ?? atCount[0]!;
}

/**
 * The standard edition's track count, read from the releases an album payload already carries
 * (a search lookup has no per-track titles). Lidarr's statistics count the monitored release, so
 * they only stand in when there are no releases.
 */
export function standardTrackCount(album: Pick<LidarrAlbum, 'releases' | 'statistics'>): number {
  return pickStandardRelease(album.releases)?.trackCount ?? album.statistics?.totalTrackCount ?? 0;
}

/**
 * The standard edition's tracks. Lidarr's album listing is the monitored release, so it stays
 * the one call made whenever that release is the standard one — every single-edition album — and
 * the fallback whenever the per-release listing comes back empty or no releases are known.
 */
export async function standardTracklist(
  lidarr: TracklistSource,
  albumId: number,
  releases: readonly LidarrAlbumRelease[] | undefined,
): Promise<LidarrTrack[]> {
  const pick = pickStandardRelease(releases);
  if (!pick || pick.monitored) return lidarr.track.listByAlbum(albumId);
  const tracks = await lidarr.track.listByRelease(pick.id);
  return tracks.length > 0 ? tracks : lidarr.track.listByAlbum(albumId);
}

/**
 * Both tracklists a hand-picked folder is judged against: the standard edition, and the full
 * monitored listing it may carry more of. One call when they are the same release.
 */
export async function albumEditions(
  lidarr: TracklistSource,
  albumId: number,
  releases: readonly LidarrAlbumRelease[] | undefined,
): Promise<{ standard: LidarrTrack[]; full: LidarrTrack[] }> {
  const full = await lidarr.track.listByAlbum(albumId);
  const pick = pickStandardRelease(releases);
  if (!pick || pick.monitored) return { standard: full, full };
  const standard = await lidarr.track.listByRelease(pick.id);
  return { standard: standard.length > 0 ? standard : full, full };
}

/**
 * {@link standardTracklist} for a caller that has not fetched the album yet. A failed album
 * lookup leaves the album listing standing, exactly as before #1936: a Lidarr hiccup on the
 * releases must not cost the acquire its tracklist.
 */
export async function fetchStandardTracklist(
  lidarr: TracklistSource & {
    album: { get(albumId: number): Promise<{ releases?: LidarrAlbumRelease[] }> };
  },
  albumId: number,
): Promise<LidarrTrack[]> {
  let releases: LidarrAlbumRelease[] | undefined;
  try {
    releases = (await lidarr.album.get(albumId)).releases;
  } catch {
    releases = undefined;
  }
  return standardTracklist(lidarr, albumId, releases);
}

/**
 * The tracklist of a folder someone picked by hand: the standard edition plus every other track
 * of the album the folder actually carries. Picking the deluxe rip gets the deluxe tracks without
 * guessing which of *Monster*'s 12/24/36/64-track editions it is, and a partial rip still owes the
 * whole standard edition. Matched against `full` so a bonus "Song (demo)" never claims the plain
 * "Song" file a standard title already owns.
 */
export function folderEditionTitles(
  standard: readonly string[],
  full: readonly string[],
  files: Array<{ filename: string }>,
): string[] {
  const inStandard = new Set(standard);
  const extras = full.filter((t) => !inStandard.has(t));
  if (extras.length === 0) return [...standard];
  const carried = new Set(matchFilesToTitles(files, extras, [...full]).map((m) => m.title));
  return [...standard, ...extras.filter((t) => carried.has(t))];
}
