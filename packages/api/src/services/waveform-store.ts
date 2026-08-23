/**
 * On-disk cache of waveform artifacts (issue #643), generated on demand by
 * `GET /api/peaks/:id` — the transcode-cache recipe: content-addressed key
 * (path + mtime + size, so a replaced file misses with no invalidation
 * wiring), an in-flight map so concurrent requests share one decode, an
 * atomic tmp+rename write, and an oldest-first budget prune.
 *
 * Disk rather than a DB column on purpose: the daily backup is a whole-DB
 * `VACUUM INTO` kept N deep, so ~40 KB × every played track would be
 * multiplied by the retention count for data regenerable in under a second.
 * See docs/cache-invalidation.md.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from '@nicotind/core';
import { streamPcm } from './track-analysis.js';
import { WAVEFORM_VERSION, createWaveformReducer, type WaveformData } from './waveform-reduce.js';

const log = createLogger('waveform-store');

/** Delivers mono Float32 PCM at {@link WAVEFORM_SAMPLE_RATE} in chunks. */
export type PcmDecoder = (
  absPath: string,
  onChunk: (samples: Float32Array) => void,
) => Promise<void>;

/** 44.1 kHz so the 6–16 kHz band exists (Nyquist 22 kHz). */
export const WAVEFORM_SAMPLE_RATE = 44_100;

// Soft cap — a derived/regenerable cache, so exceeding it just evicts oldest.
// ~40 KB per 4-minute track → ~12k tracks before the first eviction.
const DEFAULT_BUDGET_BYTES = 512 * 1024 * 1024;

const inFlight = new Map<string, Promise<WaveformData>>();

const defaultDecoder: PcmDecoder = (absPath, onChunk) =>
  streamPcm(absPath, { sampleRate: WAVEFORM_SAMPLE_RATE, onChunk });

export function waveformCacheKey(absPath: string, mtimeMs: number, sizeBytes: number): string {
  return createHash('sha1')
    .update(`${absPath}|${Math.round(mtimeMs)}|${sizeBytes}|${WAVEFORM_VERSION}`)
    .digest('hex');
}

function readCached(file: string): WaveformData | null {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as WaveformData;
    if (parsed?.version !== WAVEFORM_VERSION || !Array.isArray(parsed.peaks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function getWaveform(
  cacheDir: string,
  absPath: string,
  opts: { decoder?: PcmDecoder; budgetBytes?: number } = {},
): Promise<WaveformData> {
  const decoder = opts.decoder ?? defaultDecoder;
  const budgetBytes = opts.budgetBytes ?? DEFAULT_BUDGET_BYTES;
  const st = statSync(absPath);
  const outPath = join(cacheDir, `${waveformCacheKey(absPath, st.mtimeMs, st.size)}.json`);

  const cached = readCached(outPath);
  if (cached) return cached;
  // A corrupt/partial file at the final name is a miss; drop it so the write
  // below lands on a clean name.
  rmSync(outPath, { force: true });

  let pending = inFlight.get(outPath);
  if (!pending) {
    pending = (async () => {
      const reducer = createWaveformReducer(WAVEFORM_SAMPLE_RATE);
      await decoder(absPath, (chunk) => reducer.push(chunk));
      const data = reducer.finish();
      mkdirSync(cacheDir, { recursive: true });
      const tmp = `${outPath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, outPath);
      void pruneWaveformCache(cacheDir, budgetBytes).catch((err) =>
        log.debug({ err }, 'waveform cache prune failed'),
      );
      return data;
    })().finally(() => inFlight.delete(outPath));
    inFlight.set(outPath, pending);
  }
  return pending;
}

/** Evict oldest artifacts (by mtime) until the directory fits `budgetBytes`. */
export async function pruneWaveformCache(cacheDir: string, budgetBytes: number): Promise<void> {
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

/** Test-only: forget in-flight decodes. */
export function _resetWaveformCacheForTests(): void {
  inFlight.clear();
}
