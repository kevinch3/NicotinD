import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, statSync } from 'node:fs';
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
  vocalRemoval?: boolean,
) => Promise<void>;

export interface TranscodeCacheOptions {
  transcoder?: FileTranscoder;
  /** Max total bytes of transcoded copies to keep on disk (evicts oldest first). */
  budgetBytes?: number;
}

// Default disk budget for transcoded copies. They're a derived/regenerable cache,
// so this is a soft cap — exceeding it just triggers oldest-first eviction.
const DEFAULT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024; // 2 GiB

// In-flight transcodes keyed by output path, so two concurrent plays of the same
// track (or a play + its pre-buffer) don't spawn two ffmpegs for one cache entry.
const inFlight = new Map<string, Promise<string>>();

/** Deterministic cache id: source path + mtime + target format/bitrate + vocal removal flag. */
export function transcodeCacheKey(
  absPath: string,
  mtimeMs: number,
  format: TranscodeFmt,
  kbps: number,
  vocalRemoval = false,
): string {
  return createHash('sha1')
    .update(`${absPath}|${Math.round(mtimeMs)}|${format}|${kbps}|${vocalRemoval ? 1 : 0}`)
    .digest('hex');
}

/**
 * Return the path to a transcoded copy of `absPath`, transcoding (once) on a
 * cache miss. The returned file is a complete on-disk file, so the caller can
 * serve it with HTTP range support — this is what makes seeking work on
 * transcoded streams. Concurrent requests for the same entry share one transcode.
 *
 * The key includes the source mtime, so re-encoding the original (e.g. the
 * lossless→Opus migration) naturally invalidates the stale transcode.
 *
 * When `vocalRemoval` is true, the cache key includes that flag so vocal-removed
 * variants are stored separately from normal transcodes.
 */
export async function getTranscodedFile(
  cacheDir: string,
  absPath: string,
  format: TranscodeFmt,
  kbps: number,
  opts: TranscodeCacheOptions & { vocalRemoval?: boolean } = {},
): Promise<string> {
  const transcoder = opts.transcoder ?? defaultTranscodeToFile;
  const budgetBytes = opts.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const vocalRemoval = opts.vocalRemoval ?? false;

  const st = statSync(absPath);
  const key = transcodeCacheKey(absPath, st.mtimeMs, format, kbps, vocalRemoval);
  const outPath = join(cacheDir, `${key}.${transcodeExt(format)}`);
  if (existsSync(outPath)) return outPath;

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
    try {
      await unlink(f.path);
      total -= f.size;
    } catch {
      /* ignore */
    }
  }
}
