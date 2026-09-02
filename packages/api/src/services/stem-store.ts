/**
 * On-disk cache of separated instrumental stems (issue #603) — the
 * `waveform-store.ts` recipe: a content-addressed key (source path + mtime +
 * size, plus the model id and a store version so a model swap is a miss, not
 * a migration), an in-flight map so concurrent requests share one separation,
 * an atomic tmp+rename write, and an oldest-first budget prune.
 *
 * The stem is the sidecar's FLAC, landed here whole. It is never served
 * directly: the transcode cache derives the streamed `|stem` variant from it
 * (keyed on the ORIGINAL's identity) with the unchanged `transcodeToFile`, so
 * the 55 s GPU pass is paid once per track and never per format/bitrate.
 *
 * Integrity is the transcode cache's own contract: the FLAC is validated
 * against the ORIGINAL's duration before the rename (`validateTranscodeOutput`
 * — music-metadata on the source, ffprobe on the stem, 1 s tolerance), so a
 * partial body from a dying sidecar can never sit at the final name, and the
 * 1 KiB floor guards the hit. See docs/vocal-separation.md and
 * docs/cache-invalidation.md.
 */
import { createHash } from 'node:crypto';
import { createWriteStream, mkdirSync, renameSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createLogger } from '@nicotind/core';
import { validateTranscodeOutput } from './transcode.js';

const log = createLogger('stem-store');

/** Bump when the model, checkpoint or chunking changes — old stems become misses. */
export const STEM_VERSION = 1;
export const STEM_MODEL_ID = 'bs_roformer_ft1_anvuew_sdr_12.55';
/** ~25 MB per 3.5-min track as 16-bit FLAC → ~40 songs. On-demand only, so
 *  growth tracks actual karaoke use. */
export const STEM_CACHE_BUDGET_BYTES = 1024 * 1024 * 1024;

// Same floor as the transcode cache: a header-only or zero-byte file at the
// final name must be a miss, never a hit.
const MIN_USABLE_STEM_BYTES = 1024;

/** Fetches the sidecar's FLAC for a library-relative path (injectable for tests). */
export type StemProducer = (relPath: string, opts: { timeoutMs: number }) => Promise<Response>;

export class StemOutputRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StemOutputRejectedError';
  }
}

const inFlight = new Map<string, Promise<string>>();

export function stemCacheKey(
  absPath: string,
  mtimeMs: number,
  sizeBytes: number,
  modelId = STEM_MODEL_ID,
): string {
  return createHash('sha1')
    .update(`${absPath}|${Math.round(mtimeMs)}|${sizeBytes}|stem|${modelId}|${STEM_VERSION}`)
    .digest('hex');
}

/** Where the stem for `absPath` lives (or would live) — keyed on its current identity. */
export function stemPathFor(cacheDir: string, absPath: string): string {
  const st = statSync(absPath);
  return join(cacheDir, `${stemCacheKey(absPath, st.mtimeMs, st.size)}.flac`);
}

/** The usable stem for `absPath`, or null. Synchronous: the stream route stats, never waits. */
export function readyStemPath(cacheDir: string, absPath: string): string | null {
  try {
    const p = stemPathFor(cacheDir, absPath);
    const s = statSync(p);
    return s.isFile() && s.size >= MIN_USABLE_STEM_BYTES ? p : null;
  } catch {
    return null;
  }
}

export interface ProduceStemOptions {
  producer: StemProducer;
  timeoutMs: number;
  /** Source-vs-output duration check; defaults to the transcode cache's own. */
  validate?: (sourcePath: string, outputPath: string) => Promise<boolean>;
  budgetBytes?: number;
}

/**
 * Produce (once) the stem for `absPath`, streaming the sidecar's body to a
 * temp sibling, validating it against the original, and renaming it into
 * place. Concurrent callers for the same stem share one production.
 */
export async function produceStem(
  cacheDir: string,
  absPath: string,
  relPath: string,
  opts: ProduceStemOptions,
): Promise<string> {
  const outPath = stemPathFor(cacheDir, absPath);
  if (readyStemPath(cacheDir, absPath)) return outPath;
  const validate = opts.validate ?? validateTranscodeOutput;
  const budgetBytes = opts.budgetBytes ?? STEM_CACHE_BUDGET_BYTES;

  let pending = inFlight.get(outPath);
  if (!pending) {
    pending = (async () => {
      mkdirSync(cacheDir, { recursive: true });
      rmSync(outPath, { force: true });
      const tmp = `${outPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        const res = await opts.producer(relPath, { timeoutMs: opts.timeoutMs });
        if (!res.body) throw new StemOutputRejectedError('separator returned an empty body');
        await pipeline(Readable.fromWeb(res.body as never), createWriteStream(tmp));
        if (statSync(tmp).size < MIN_USABLE_STEM_BYTES) {
          throw new StemOutputRejectedError('separator returned a sub-floor stem');
        }
        if (!(await validate(absPath, tmp))) {
          throw new StemOutputRejectedError(
            `stem for ${absPath} failed the duration check against its source`,
          );
        }
        renameSync(tmp, outPath);
      } catch (err) {
        try {
          unlinkSync(tmp);
        } catch {
          /* never landed */
        }
        throw err;
      }
      void pruneStemCache(cacheDir, budgetBytes).catch((err) =>
        log.debug({ err }, 'stem cache prune failed'),
      );
      return outPath;
    })().finally(() => inFlight.delete(outPath));
    inFlight.set(outPath, pending);
  }
  return pending;
}

/** Evict oldest stems (by mtime) until the directory fits `budgetBytes`. */
export async function pruneStemCache(cacheDir: string, budgetBytes: number): Promise<void> {
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return;
  }
  const files: { path: string; size: number; mtimeMs: number }[] = [];
  let total = 0;
  for (const name of names) {
    if (name.includes('.tmp-')) continue;
    const path = join(cacheDir, name);
    try {
      const s = await stat(path);
      if (s.isFile()) {
        files.push({ path, size: s.size, mtimeMs: s.mtimeMs });
        total += s.size;
      }
    } catch {
      /* raced deletion */
    }
  }
  if (total <= budgetBytes) return;
  files.sort((a, b) => a.mtimeMs - b.mtimeMs);
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

/** Test-only: clear in-flight state. */
export function _resetStemStoreForTests(): void {
  inFlight.clear();
}
