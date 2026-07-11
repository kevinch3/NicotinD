import { join, normalize } from 'node:path';
import { normalizeForGrouping } from './album-grouping.js';

/**
 * Pure helpers shared by the batch backfill scripts (scripts/analyze-bpm.ts,
 * scripts/backfill-genre.ts). Kept dependency-light so the selection/grouping
 * logic is unit-testable; the scripts gather rows from the DB and apply each
 * result via the already-tested `analyzeBpm` / `verifyGenre` + `writeAudioTags`.
 */

function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

/**
 * Resolve a `library_songs.path` to an absolute file path under the music dir.
 * Mirrors the route's `resolveSongPath`: a stored path may be absolute (pass it
 * through) or relative to the music dir (join), with `\` normalized to `/`.
 */
export function resolveSongAbsPath(musicDir: string, songPath: string): string {
  const normalized = songPath.replace(/\\/g, '/');
  if (isAbsolutePath(normalized)) return normalize(normalized);
  return normalize(join(musicDir, normalized));
}

/** Stored vs freshly-detected BPM within this margin count as agreement. */
const BPM_AGREE_TOLERANCE = 2;

/**
 * Decide whether a re-detected BPM should replace the stored one (the
 * `--recheck` backfill: repairing music-tempo's octave errors with Essentia).
 *
 * - A missing stored BPM is filled at any confidence — same posture as the
 *   enrichment task, anything beats nothing.
 * - An existing stored BPM is only overwritten when the new detection is
 *   confident (`confidence >= minConfidence`, Essentia's 0–5.32 scale) AND
 *   actually disagrees (beyond ±2 BPM) — low-confidence detections on e.g.
 *   rubato ballads must not churn plausible stored values.
 */
export function shouldUpdateBpm(
  stored: number | null,
  next: number,
  confidence: number,
  minConfidence: number,
): boolean {
  if (!Number.isFinite(next) || next <= 0) return false;
  if (stored === null) return true;
  if (confidence < minConfidence) return false;
  return Math.abs(Math.round(next) - stored) > BPM_AGREE_TOLERANCE;
}

export interface ArtistGroup<T> {
  /** The display artist of the first song in the group. */
  artist: string;
  /** The grouping key (`normalizeForGrouping(artist)`). */
  key: string;
  songs: T[];
}

/**
 * Group songs by normalized artist so a genre lookup runs once per artist
 * (verifyGenre is artist-scoped), not once per song. Songs with an empty/
 * whitespace artist are dropped (no artist to look up). Order is stable:
 * groups appear in first-seen order.
 */
export function groupSongsByArtist<T extends { artist: string }>(songs: T[]): ArtistGroup<T>[] {
  const groups = new Map<string, ArtistGroup<T>>();
  for (const song of songs) {
    const artist = (song.artist ?? '').trim();
    if (!artist) continue;
    const key = normalizeForGrouping(artist);
    if (!key) continue;
    const existing = groups.get(key);
    if (existing) existing.songs.push(song);
    else groups.set(key, { artist, key, songs: [song] });
  }
  return [...groups.values()];
}

export interface GenreAssignment<T> {
  song: T;
  artist: string;
  genre: string;
}

/**
 * Plan genre assignments: group songs by artist, look the genre up once per
 * artist via the injected `lookup` (returns the suggested genre or null), and
 * fan a non-null result out to every song in that group. The injected lookup
 * makes this offline-testable (the script passes a verifyGenre wrapper).
 * Artists the lookup can't resolve are skipped and counted via `skippedArtists`.
 */
export async function planGenreBackfill<T extends { artist: string }>(
  songs: T[],
  lookup: (artist: string) => Promise<string | null>,
): Promise<{ assignments: GenreAssignment<T>[]; skippedArtists: string[] }> {
  const assignments: GenreAssignment<T>[] = [];
  const skippedArtists: string[] = [];
  for (const group of groupSongsByArtist(songs)) {
    const genre = await lookup(group.artist);
    if (!genre) {
      skippedArtists.push(group.artist);
      continue;
    }
    for (const song of group.songs) assignments.push({ song, artist: group.artist, genre });
  }
  return { assignments, skippedArtists };
}
