import { statSync } from 'node:fs';
import { TranscodeOutputRejectedError } from './transcode.js';

/**
 * Remember which source files cannot be transcoded, so a doomed ffmpeg pass
 * isn't re-run on every play (issue #317).
 *
 * why: when a source carries damaged frames, ffmpeg — with the deliberate
 * `-fflags +discardcorrupt -err_detect explode` flags — drops them and **exits
 * 0**, producing a shorter-but-valid output. `validateTranscodeOutput` rejects
 * it and the route serves the original, which is the right outcome for the
 * listener. Nothing recorded that verdict though, so every subsequent play
 * repeated the whole pass.
 *
 * Measured on prod: one file (`04 Desesperada 2004…mp3`, 227.1 s source →
 * 219.4 s output, 7.8 s of frames discarded) burned a full ffmpeg pass and
 * logged a fresh ERROR on each of 4 plays in a week.
 *
 * ## In-memory, not a table
 *
 * Mirrors the `noArtCache` negative cache that already lives beside it in
 * `routes/streaming.ts`. A persistent `library_song_transcode_failures` table
 * would survive restarts, but for a handful of damaged files a table plus
 * migration plus prune wiring is disproportionate — and a restart re-testing
 * the file is harmless (it just fails once more and re-learns).
 *
 * ## The key is the file's identity, not its path
 *
 * `path + size + mtime`, so a **re-download that repairs the file transcodes
 * normally again** with no manual eviction. That is the same content-identity
 * discipline `scan_cache` uses, and the reason a path-only key would be wrong:
 * the whole point of a corrupt file is that someone will eventually replace it.
 */

/** Bounded so a pathological library can't grow this without limit. */
const MAX_ENTRIES = 500;

const failures = new Map<string, true>();

/** `path:size:mtimeMs`, or null when the file can't be stat'd. */
export function transcodeFailureKey(absPath: string): string | null {
  try {
    const st = statSync(absPath);
    return `${absPath}:${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    // No stat, no stable identity — never cache a verdict we can't invalidate.
    return null;
  }
}

/** True when this exact file has already produced an unusable transcode. */
export function isKnownUntranscodable(absPath: string): boolean {
  const key = transcodeFailureKey(absPath);
  return key !== null && failures.has(key);
}

/**
 * Only a deterministic rejection is cacheable. An ffmpeg crash, an OOM kill or
 * a full disk throws a bare `Error` here and must stay retryable — caching one
 * would turn a recoverable outage into a permanent no-transcode until restart.
 */
export function isDeterministicTranscodeFailure(err: unknown): boolean {
  return err instanceof TranscodeOutputRejectedError;
}

/**
 * Record that this exact file cannot be transcoded. A no-op unless `err` is the
 * deterministic rejection, so the cache's blast radius equals its evidence.
 */
export function rememberTranscodeFailure(absPath: string, err: unknown): void {
  if (!isDeterministicTranscodeFailure(err)) return;
  const key = transcodeFailureKey(absPath);
  if (key === null) return;
  // Cheap FIFO bound: drop the oldest insertion rather than grow forever.
  if (failures.size >= MAX_ENTRIES) {
    const oldest = failures.keys().next().value;
    if (oldest !== undefined) failures.delete(oldest);
  }
  failures.set(key, true);
}

/** Test seam / manual reset. */
export function clearTranscodeFailures(): void {
  failures.clear();
}

/** Current entry count — exposed for assertions, not for callers. */
export function transcodeFailureCount(): number {
  return failures.size;
}
