import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, statSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@nicotind/core';
import {
  type TranscodeFmt,
  transcodeExt,
  transcodeToFile as defaultTranscodeToFile,
} from './transcode.js';

const log = createLogger('transcode-cache');

/** Pluggable for tests — the default spawns ffmpeg (`transcodeToFile`). */
export type FileTranscoder = (
  absPath: string,
  outPath: string,
  format: TranscodeFmt,
  kbps: number,
  vocalRemoval: boolean,
) => Promise<void>;

export interface TranscodeCacheOptions {
  transcoder?: FileTranscoder;
  /** Max total bytes of transcoded copies to keep on disk (evicts oldest first). */
  budgetBytes?: number;
  /** When true, produce (and key) a vocal-muted variant — a distinct cache entry. */
  vocalRemoval?: boolean;
}

// Default disk budget for transcoded copies. They're a derived/regenerable cache,
// so this is a soft cap — exceeding it just triggers oldest-first eviction.
const DEFAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

// In-flight transcodes keyed by output path, so two concurrent plays of the same
// track (or a play + its pre-buffer) don't spawn two ffmpegs for one cache entry.
const inFlight = new Map<string, Promise<string>>();

// Paths currently being served by an HTTP response. The pruner skips these so
// a cache-eviction can't yank a file out from under an in-flight read.
// Refcounted because the same cache entry can be served by multiple concurrent
// requests (a play + its pre-buffered standby element).
const inUse = new Map<string, number>();

// Outputs below this size are treated as garbage (a half-written or zero-byte
// file landed at the final name would be served verbatim otherwise — that's
// the root cause of the "plays 1-2s then ends" bug). 1 KiB comfortably
// accommodates the smallest valid container header for any format we emit.
const MIN_USABLE_OUTPUT_BYTES = 1024;

/**
 * Deterministic cache id: source path + mtime + size + target format/bitrate,
 * plus a `novox` marker for the vocal-muted variant. Source size is part of
 * the key so a file replacement with an unchanged mtime (a 1-second resolution
 * on some filesystems) cannot silently reuse a stale transcode.
 */
export function transcodeCacheKey(
  absPath: string,
  mtimeMs: number,
  sizeBytes: number,
  format: TranscodeFmt,
  kbps: number,
  vocalRemoval = false,
): string {
  const vox = vocalRemoval ? '|novox' : '';
  return createHash('sha1')
    .update(
      `${absPath}|${Math.round(mtimeMs)}|${sizeBytes}|${format}|${kbps}${vox}`,
    )
    .digest('hex');
}

/**
 * Mark a cache file as in-use so {@link pruneTranscodeCache} won't delete it
 * while a streaming response is still reading it. Callers MUST pair each
 * `pinTranscodeCacheFile` with exactly one `unpinTranscodeCacheFile` (the
 * returned Release function) — usually in a `try/finally` around the response.
 */
export function pinTranscodeCacheFile(outPath: string): () => void {
  inUse.set(outPath, (inUse.get(outPath) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (inUse.get(outPath) ?? 1) - 1;
    if (next <= 0) inUse.delete(outPath);
    else inUse.set(outPath, next);
  };
}

/** True when the file at `p` is a regular file large enough to serve. */
function isUsableCacheFile(p: string): boolean {
  try {
    const s = statSync(p);
    return s.isFile() && s.size >= MIN_USABLE_OUTPUT_BYTES;
  } catch {
    return false;
  }
}

/**
 * Return the path to a transcoded copy of `absPath`, transcoding (once) on a
 * cache miss. The returned file is a complete on-disk file, so the caller can
 * serve it with HTTP range support — this is what makes seeking work on
 * transcoded streams. Concurrent requests for the same entry share one transcode.
 *
 * The key includes the source mtime AND size, so re-encoding the original
 * (e.g. the lossless→Opus migration) or replacing it with a same-mtime file
 * both naturally invalidate the stale transcode.
 *
 * The cache hit is guarded by a size/stat check, not just `existsSync`, so a
 * corrupt zero-byte or pre-rename-protection file at the final name is treated
 * as a miss and re-transcoded (the user sees one slow first-play, not a short
 * playback that fires `ended` early).
 */
export async function getTranscodedFile(
  cacheDir: string,
  absPath: string,
  format: TranscodeFmt,
  kbps: number,
  opts: TranscodeCacheOptions = {},
): Promise<string> {
  const transcoder = opts.transcoder ?? defaultTranscodeToFile;
  const budgetBytes = opts.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const vocalRemoval = opts.vocalRemoval ?? false;

  const st = statSync(absPath);
  const key = transcodeCacheKey(
    absPath,
    st.mtimeMs,
    st.size,
    format,
    kbps,
    vocalRemoval,
  );
  const outPath = join(cacheDir, `${key}.${transcodeExt(format)}`);
  if (isUsableCacheFile(outPath)) return outPath;
  // Unusable hit (missing, 0 bytes, or smaller than the floor) — drop it so
  // the upcoming transcode produces a clean file instead of failing to write
  // over a corrupt name.
  try {
    rmSync(outPath, { force: true });
  } catch {
    /* best-effort */
  }

  let pending = inFlight.get(outPath);
  if (!pending) {
    pending = (async () => {
      mkdirSync(cacheDir, { recursive: true });
      await transcoder(absPath, outPath, format, kbps, vocalRemoval);
      void pruneTranscodeCache(cacheDir, budgetBytes).catch((err) =>
        log.debug({ err }, 'transcode cache prune failed'),
      );
      return outPath;
    })().finally(() => inFlight.delete(outPath));
    inFlight.set(outPath, pending);
  }
  return pending;
}

/** Evict oldest cache files (by mtime) until total size is within `budgetBytes`. */
export async function pruneTranscodeCache(cacheDir: string, budgetBytes: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return; // dir doesn't exist yet
  }
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  let total = 0;
  for (const name of names) {
    if (name.includes('.tmp-')) continue; // skip in-progress temp files
    const path = join(cacheDir, name);
    try {
      const s = await stat(path);
      if (s.isFile()) {
        files.push({ path, size: s.size, mtimeMs: s.mtimeMs });
        total += s.size;
      }
    } catch {
      /* raced deletion — ignore */
    }
  }
  if (total <= budgetBytes) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
  for (const f of files) {
    if (total <= budgetBytes) break;
    // Skip files currently being served — eviction must not yank a file out
    // from under a streaming response still reading from it.
    if (inUse.has(f.path)) continue;
    try {
      await unlink(f.path);
      total -= f.size;
    } catch {
      /* ignore */
    }
  }
}

/** Test-only: reset all in-process state (in-flight, in-use). */
export function _resetTranscodeCacheForTests(): void {
  inFlight.clear();
  inUse.clear();
}

/** Test-only: returns the current pin refcount for a path (0 = unpinned). */
export function _pinRefcountForTests(outPath: string): number {
  return inUse.get(outPath) ?? 0;
}
