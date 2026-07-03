import { spawn } from 'node:child_process';
import { createLogger } from '@nicotind/core';

const log = createLogger('loudness-analysis');

/**
 * Loudness + energy analysis via ffmpeg's EBU R128 filter. Deliberately
 * sidecar-free (unlike the model-derived features): `ebur128` ships with every
 * ffmpeg build, so energy/loudness stay available even when the analysis
 * service is down — they're also the features the sequencing layer leans on
 * hardest (energy arcs, loudness-jump avoidance).
 */

export interface LoudnessResult {
  /** Integrated loudness in LUFS (EBU R128 "I"). */
  loudness: number;
  /** Perceived energy 0..1, derived from loudness + dynamic range. */
  energy: number;
}

/** Silent/near-silent programme material reports -inf or absurdly low LUFS. */
const SILENCE_FLOOR_LUFS = -70;

/**
 * Parse ffmpeg `ebur128` stderr output. Only the final Summary block matters:
 *
 *   [Parsed_ebur128_0 @ ...] Summary:
 *     Integrated loudness:
 *       I:         -9.3 LUFS
 *       ...
 *     Loudness range:
 *       LRA:        6.2 LU
 *
 * Returns null when no summary is present (decode failure, not audio).
 */
export function parseEbur128Output(
  stderr: string,
): { integratedLufs: number; loudnessRange: number } | null {
  const summaryAt = stderr.lastIndexOf('Summary:');
  if (summaryAt === -1) return null;
  const tail = stderr.slice(summaryAt);

  const iMatch = tail.match(/I:\s*(-inf|-?\d+(?:\.\d+)?)\s*LUFS/);
  if (!iMatch) return null;
  const integratedLufs =
    iMatch[1] === '-inf' ? SILENCE_FLOOR_LUFS : Math.max(SILENCE_FLOOR_LUFS, Number(iMatch[1]));
  if (!Number.isFinite(integratedLufs)) return null;

  const lraMatch = tail.match(/LRA:\s*(\d+(?:\.\d+)?)\s*LU\b/);
  const loudnessRange = lraMatch ? Number(lraMatch[1]) : 0;
  return { integratedLufs, loudnessRange };
}

/**
 * Map integrated loudness + dynamic range to a 0..1 energy score.
 *
 * Heuristic, tuned to music masters: loudness dominates (a -7 LUFS club master
 * is high energy, a -25 LUFS ambient piece is low), while a wide loudness range
 * (dynamic classical/jazz) damps the score a little — relentless compressed
 * material *feels* more energetic than dynamic material at the same integrated
 * level. Monotonic in loudness for a fixed range; always in [0, 1].
 */
export function computeEnergy(integratedLufs: number, loudnessRange: number): number {
  const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));
  // -25 LUFS → 0, -7 LUFS → 1 (linear between).
  const base = clamp01((integratedLufs + 25) / 18);
  // LRA beyond ~3 LU (typical for compressed masters) damps up to 25%.
  const damp = clamp01((loudnessRange - 3) / 15) * 0.25;
  return clamp01(base * (1 - damp));
}

/**
 * Measure a track's integrated loudness with ffmpeg `ebur128` and derive the
 * energy score. Returns null when ffmpeg fails or produces no summary. Pure
 * analysis — no DB or tag writes.
 */
export async function analyzeLoudness(absPath: string): Promise<LoudnessResult | null> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    absPath,
    '-map',
    'a:0',
    '-filter:a',
    'ebur128',
    '-f',
    'null',
    '-',
  ];
  const stderr = await new Promise<string | null>((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const chunks: Buffer[] = [];
    proc.stderr.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', () => resolve(null));
    proc.on('close', (code) => {
      resolve(code === 0 ? Buffer.concat(chunks).toString('utf8') : null);
    });
  });
  if (stderr === null) {
    log.warn({ absPath }, 'ebur128 analysis failed');
    return null;
  }
  const parsed = parseEbur128Output(stderr);
  if (!parsed) {
    log.warn({ absPath }, 'ebur128 produced no summary');
    return null;
  }
  return {
    loudness: Math.round(parsed.integratedLufs * 10) / 10,
    energy: Math.round(computeEnergy(parsed.integratedLufs, parsed.loudnessRange) * 1000) / 1000,
  };
}
