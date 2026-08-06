import { join, normalize, relative } from 'node:path';

/**
 * The path-safety triad (+ `expandDir`) for resolving a `library_songs.path`
 * to an absolute on-disk location and proving it stays inside the music dir.
 *
 * Extracted (issue #416) from three byte-identical copies — routes/library.ts,
 * services/library-deletion.ts, routes/download-review.ts — the last of which
 * carried a comment apologizing for being a copy. Any route/service that
 * touches a song's file must use these, in this order:
 * `expandDir(musicDir)` → `resolveSongPath` → `isUnderMusicDir` (traversal
 * guard) before any fs call.
 *
 * `services/track-backfill.ts` (`resolveSongAbsPath`) and
 * `services/candidate-sources.ts` keep their local resolve-only variants on
 * purpose: they deliberately omit the music-dir containment check (read-only
 * paths that may legitimately sit outside the library).
 */

export function expandDir(dir: string): string {
  if (dir.startsWith('~')) {
    return join(process.env.HOME ?? '/root', dir.slice(1));
  }
  return dir;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-zA-Z]:\//.test(path);
}

export function resolveSongPath(musicDir: string, songPath: string): string {
  const normalizedSongPath = songPath.replace(/\\/g, '/');
  if (isAbsolutePath(normalizedSongPath)) {
    return normalize(normalizedSongPath);
  }
  return normalize(join(musicDir, normalizedSongPath));
}

export function isUnderMusicDir(musicDir: string, candidatePath: string): boolean {
  const rel = relative(musicDir, candidatePath);
  return rel !== '' && !rel.startsWith('..');
}
