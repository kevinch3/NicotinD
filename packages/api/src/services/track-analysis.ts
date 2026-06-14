import { spawn } from 'node:child_process';
import { createLogger, type GenreSuggestion } from '@nicotind/core';
import type { Lidarr } from '@nicotind/lidarr-client';
import { normalizeForGrouping } from './album-grouping.js';

const log = createLogger('track-analysis');

// music-tempo's onset detection is tuned for 44.1 kHz (hopSize 441 = 10 ms), so
// decode to that rate. A ~90 s mono slice is plenty to lock a stable tempo while
// keeping the decode fast and memory bounded.
const ANALYZE_SAMPLE_RATE = 44_100;
const ANALYZE_SECONDS = 90;

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
    proc.stdout.on('data', (d: Buffer) => chunks.push(d));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg PCM decode exited with code ${code}`));
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
export async function analyzeBpm(absPath: string): Promise<number | null> {
  const MusicTempo = await getMusicTempo();
  if (!MusicTempo) return null;
  let samples: Float32Array;
  try {
    samples = await decodePcm(absPath);
  } catch (err) {
    log.warn({ err, absPath }, 'BPM decode failed');
    return null;
  }
  // music-tempo needs a few seconds of audio to produce a meaningful estimate.
  if (samples.length < ANALYZE_SAMPLE_RATE * 5) return null;
  try {
    const mt = new MusicTempo(samples);
    const bpm = Math.round(mt.tempo);
    return Number.isFinite(bpm) && bpm > 0 ? bpm : null;
  } catch (err) {
    log.warn({ err, absPath }, 'BPM estimation failed');
    return null;
  }
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
  const match =
    hits.find((a) => normalizeForGrouping(a.artistName) === want) ?? hits[0];
  const candidates = (match?.genres ?? []).map((g) => g.trim()).filter((g) => g.length > 0);
  if (candidates.length === 0) return base;

  const curNorm = (input.currentGenre ?? '').trim().toLowerCase();
  const suggested = candidates.find((g) => g.toLowerCase() !== curNorm) ?? candidates[0]!;
  return { current: input.currentGenre, suggested, candidates, source: 'lidarr' };
}
