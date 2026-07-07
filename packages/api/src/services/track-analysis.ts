import { spawn } from 'node:child_process';
import { createLogger, type GenreSuggestion } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import { normalizeForGrouping } from './album-grouping.js';
import { detectKey } from './key-detection.js';

const log = createLogger('track-analysis');

// music-tempo's onset detection is tuned for 44.1 kHz (hopSize 441 = 10 ms), so
// decode to that rate. A ~90 s mono slice is plenty to lock a stable tempo while
// keeping the decode fast and memory bounded.
const ANALYZE_SAMPLE_RATE = 44_100;
const ANALYZE_SECONDS = 90;
// Hard wall-clock cap on a single ffmpeg decode. A 90 s slice decodes far faster
// than realtime, so this only ever trips on a pathological/hung file — killing it
// keeps one bad file from wedging a worker (and the whole run) forever.
const DECODE_TIMEOUT_MS = 120_000;

type MusicTempoCtor = new (
  audioData: Float32Array | number[],
  params?: Record<string, number>,
) => { tempo: number };

let mtPromise: Promise<MusicTempoCtor | null> | null = null;
async function getMusicTempo(): Promise<MusicTempoCtor | null> {
  if (!mtPromise) {
    mtPromise = import('music-tempo')
      .then((mod) => ((mod as { default?: unknown }).default ?? mod) as MusicTempoCtor)
      .catch((err) => {
        log.warn({ err }, 'music-tempo unavailable — BPM analysis disabled');
        return null;
      });
  }
  return mtPromise;
}

/**
 * A deterministic per-file "the analysis ran but found nothing" outcome (signal
 * too short/quiet to lock a tempo, no tonal content for key detection). Passed
 * to `onError` so callers can stop retrying the file — the windowed processor
 * records it in the analysis-failure ledger (excluding the file after the
 * attempt cap) but does NOT count it as a run failure, since nothing is broken.
 * Environmental nulls (music-tempo module unavailable) deliberately do not use
 * this: they must leave files pending so they're retried once the env is fixed.
 */
export class NoConfidentResultError extends Error {}

/** Trim ffmpeg stderr to its last non-empty line(s) for a compact diagnostic. */
export function summarizeFfmpegStderr(stderr: string, maxLen = 400): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return '';
  // The final line is usually the actual decode error (e.g. "Invalid data found
  // when processing input"); keep the tail so the reason survives truncation.
  const tail = lines.slice(-3).join(' | ');
  return tail.length > maxLen ? `…${tail.slice(-maxLen)}` : tail;
}

/** Decode the head of a file to mono 32-bit-float PCM samples via ffmpeg. */
function decodePcm(absPath: string): Promise<Float32Array> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    '-t',
    String(ANALYZE_SECONDS),
    '-i',
    absPath,
    '-vn',
    '-ac',
    '1',
    '-ar',
    String(ANALYZE_SAMPLE_RATE),
    '-f',
    'f32le',
    'pipe:1',
  ];
  return new Promise<Float32Array>((resolve, reject) => {
    const proc = spawn('ffmpeg', args);
    const chunks: Buffer[] = [];
    // Capture stderr so a non-zero exit reports *why* ffmpeg failed instead of a
    // bare exit code — the difference between "codec not found" (build problem)
    // and "Invalid data" (corrupt file). why: bug where every decode failed with
    // an opaque "exited with code 183" and the real reason was thrown away.
    const errChunks: Buffer[] = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGKILL');
    }, DECODE_TIMEOUT_MS);
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.stderr.on('data', (d: Buffer) => errChunks.push(d));
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`ffmpeg PCM decode timed out after ${DECODE_TIMEOUT_MS}ms`));
        return;
      }
      if (code !== 0) {
        const detail = summarizeFfmpegStderr(Buffer.concat(errChunks).toString('utf8'));
        reject(
          new Error(`ffmpeg PCM decode exited with code ${code}${detail ? `: ${detail}` : ''}`),
        );
        return;
      }
      const buf = Buffer.concat(chunks);
      // Wrap the raw bytes as f32; copy into a clean aligned Float32Array.
      const floats = new Float32Array(buf.length / 4);
      for (let i = 0; i < floats.length; i++) floats[i] = buf.readFloatLE(i * 4);
      resolve(floats);
    });
  });
}

/**
 * Detect a track's tempo by decoding its audio and running music-tempo. Returns
 * a rounded BPM, or null when ffmpeg/music-tempo are unavailable or the signal
 * is too short/quiet to lock a tempo. Pure analysis — no DB or tag writes.
 */
export async function analyzeBpm(
  absPath: string,
  onError?: (err: unknown) => void,
): Promise<number | null> {
  const MusicTempo = await getMusicTempo();
  if (!MusicTempo) return null;
  let samples: Float32Array;
  try {
    samples = await decodePcm(absPath);
  } catch (err) {
    log.warn({ err, absPath }, 'BPM decode failed');
    onError?.(err);
    return null;
  }
  // music-tempo needs a few seconds of audio to produce a meaningful estimate.
  if (samples.length < ANALYZE_SAMPLE_RATE * 5) {
    onError?.(new NoConfidentResultError('audio too short to estimate a tempo'));
    return null;
  }
  try {
    const mt = new MusicTempo(samples);
    const bpm = Math.round(mt.tempo);
    if (Number.isFinite(bpm) && bpm > 0) return bpm;
    onError?.(new NoConfidentResultError('no confident tempo detected'));
    return null;
  } catch (err) {
    log.warn({ err, absPath }, 'BPM estimation failed');
    onError?.(new NoConfidentResultError('tempo estimation failed on this signal'));
    return null;
  }
}

/**
 * Detect a track's musical key by decoding its audio and running the
 * Krumhansl–Schmuckler estimator (see key-detection.ts). Returns a key string
 * like "C major" / "A minor", or null when ffmpeg is unavailable or the signal
 * has no tonal content. Pure analysis — no DB or tag writes.
 */
export async function analyzeKey(
  absPath: string,
  onError?: (err: unknown) => void,
): Promise<string | null> {
  let samples: Float32Array;
  try {
    samples = await decodePcm(absPath);
  } catch (err) {
    log.warn({ err, absPath }, 'key decode failed');
    onError?.(err);
    return null;
  }
  if (samples.length < ANALYZE_SAMPLE_RATE * 5) {
    onError?.(new NoConfidentResultError('audio too short to estimate a key'));
    return null;
  }
  const key = detectKey(samples, ANALYZE_SAMPLE_RATE)?.key ?? null;
  if (key === null) onError?.(new NoConfidentResultError('no tonal content detected'));
  return key;
}

/**
 * Verify a song's genre against Lidarr/MusicBrainz. Looks the artist up and
 * returns its genres (best-first) as candidates plus a single suggestion (the
 * first genre that differs from the current tag, else the top genre). Degrades
 * to `{ suggested: null, source: null }` when Lidarr is absent or has nothing.
 */
export async function verifyGenre(
  lidarr: Lidarr | null | undefined,
  input: { artist: string; currentGenre: string | null },
): Promise<GenreSuggestion> {
  const base: GenreSuggestion = {
    current: input.currentGenre,
    suggested: null,
    candidates: [],
    source: null,
  };
  if (!lidarr || !input.artist) return base;

  let hits;
  try {
    hits = await lidarr.artist.lookup(input.artist);
  } catch (err) {
    log.warn({ err, artist: input.artist }, 'Lidarr artist lookup failed');
    return base;
  }
  const want = normalizeForGrouping(input.artist);
  const match = hits.find((a) => normalizeForGrouping(a.artistName) === want) ?? hits[0];
  const candidates = (match?.genres ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
  if (candidates.length === 0) return base;

  const curNorm = (input.currentGenre ?? '').trim().toLowerCase();
  const suggested = candidates.find((g) => g.toLowerCase() !== curNorm) ?? candidates[0]!;
  return { current: input.currentGenre, suggested, candidates, source: 'lidarr' };
}
