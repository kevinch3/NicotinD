/**
 * Pure PCM → waveform artifact reducer (issue #643): the min/max envelope the
 * Now Playing waveform draws, plus a coarse six-band energy timeline the
 * karaoke VFX animates against `currentTime`.
 *
 * Streaming by design: ffmpeg's f32le pipe is fed in chunks and the reducer
 * never holds the whole track — a 60-minute mix is 635 MB of Float32 and the
 * old head-only `decodePcm` buffered everything it read. Peaks are
 * accumulated at a fixed PEAK_RATE and downsampled once at the end, so
 * memory is bounded by track length × 20 pairs/s, not by sample count.
 *
 * Deliberately sidecar-free (no Essentia, no Python): one ffmpeg decode and a
 * ~40-line radix-2 FFT, so the artifact works on a streaming-only install and
 * does not depend on the descriptors store (docs/audio-descriptors.md).
 * Processing is sample-by-sample so the result is identical however the
 * chunks are sliced — the tests pin that.
 */

import type { WaveformData } from '@nicotind/core';

export const WAVEFORM_VERSION = 1;
/** Emitted min/max pairs per track (the SVG resamples to its own width). */
export const PEAKS_BUCKETS = 600;
/** Pairs accumulated per second before the final downsample. */
export const PEAK_RATE = 20;
/** Band frames per second — enough to follow a drop, cheap to store. */
export const BAND_FRAME_RATE = 4;
/** 4096 @ 44.1 kHz → 10.8 Hz bins, so the 20–60 Hz sub-bass band has real bins. */
export const FFT_SIZE = 4096;
/** Same six perceptual bands as the descriptor sidecar (`app/bands.py`). */
export const BAND_EDGES_HZ = [20, 60, 250, 500, 2000, 6000, 16000];
const BAND_COUNT = BAND_EDGES_HZ.length - 1;

/** The wire shape lives in `@nicotind/core` so the web client shares it. */
export type { WaveformData };

/**
 * In-place iterative radix-2 FFT magnitude spectrum of a real signal whose
 * length is a power of two. Returns n/2 magnitudes (bin i ↔ i·sr/n Hz).
 */
export function fftMagnitudes(samples: Float32Array): Float32Array {
  const n = samples.length;
  if (n === 0 || (n & (n - 1)) !== 0) throw new Error(`fft size must be a power of two, got ${n}`);
  const re = Float32Array.from(samples);
  const im = new Float32Array(n);
  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const t = re[i]!;
      re[i] = re[j]!;
      re[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k;
        const b = a + len / 2;
        const tRe = re[b]! * curRe - im[b]! * curIm;
        const tIm = re[b]! * curIm + im[b]! * curRe;
        re[b] = re[a]! - tRe;
        im[b] = im[a]! - tIm;
        re[a] = re[a]! + tRe;
        im[a] = im[a]! + tIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
  const mags = new Float32Array(n / 2);
  for (let i = 0; i < n / 2; i++) mags[i] = Math.hypot(re[i]!, im[i]!);
  return mags;
}

/** Merge interleaved min/max pairs down to `buckets` pairs (min of mins, max of maxes). */
export function downsamplePeaks(pairs: number[], buckets: number): number[] {
  const n = pairs.length / 2;
  if (n <= buckets) return pairs;
  const out: number[] = [];
  for (let b = 0; b < buckets; b++) {
    const start = Math.floor((b * n) / buckets);
    const end = Math.max(start + 1, Math.floor(((b + 1) * n) / buckets));
    let lo = Infinity;
    let hi = -Infinity;
    for (let p = start; p < end; p++) {
      lo = Math.min(lo, pairs[p * 2]!);
      hi = Math.max(hi, pairs[p * 2 + 1]!);
    }
    out.push(lo, hi);
  }
  return out;
}

const round3 = (v: number): number => Math.round(v * 1000) / 1000;

export interface WaveformReducer {
  push(samples: Float32Array): void;
  finish(): WaveformData;
}

export function createWaveformReducer(sampleRate: number): WaveformReducer {
  const peakBlock = Math.max(1, Math.round(sampleRate / PEAK_RATE));
  const hop = Math.max(1, Math.round(sampleRate / BAND_FRAME_RATE));
  // Bin → band lookup, computed once.
  const binBand = new Int8Array(FFT_SIZE / 2).fill(-1);
  for (let i = 0; i < FFT_SIZE / 2; i++) {
    const f = (i * sampleRate) / FFT_SIZE;
    for (let b = 0; b < BAND_COUNT; b++) {
      if (f >= BAND_EDGES_HZ[b]! && f < BAND_EDGES_HZ[b + 1]!) {
        binBand[i] = b;
        break;
      }
    }
  }
  const hann = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE);

  const ring = new Float32Array(FFT_SIZE);
  let ringPos = 0;
  let total = 0;
  let sinceFrame = 0;
  const rawBands: number[][] = [];

  const pairs: number[] = [];
  let blockMin = Infinity;
  let blockMax = -Infinity;
  let blockCount = 0;

  const frame = new Float32Array(FFT_SIZE);
  function emitBandFrame(): void {
    // Linearise the ring (oldest sample first) and window it.
    for (let i = 0; i < FFT_SIZE; i++) frame[i] = ring[(ringPos + i) % FFT_SIZE]! * hann[i]!;
    const mags = fftMagnitudes(frame);
    const energy = new Array<number>(BAND_COUNT).fill(0);
    for (let i = 0; i < mags.length; i++) {
      const b = binBand[i]!;
      if (b >= 0) energy[b] += mags[i]! * mags[i]!;
    }
    rawBands.push(energy);
  }

  function flushPeakBlock(): void {
    if (blockCount === 0) return;
    pairs.push(blockMin, blockMax);
    blockMin = Infinity;
    blockMax = -Infinity;
    blockCount = 0;
  }

  return {
    push(samples) {
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]!;
        // Peaks honour the -1..1 contract: a hot master decodes above full
        // scale in float (prod: 1.51). The FFT below still sees the raw
        // sample, so band energies stay faithful to the signal.
        const p = s > 1 ? 1 : s < -1 ? -1 : s;
        if (p < blockMin) blockMin = p;
        if (p > blockMax) blockMax = p;
        if (++blockCount === peakBlock) flushPeakBlock();
        ring[ringPos] = s;
        ringPos = (ringPos + 1) % FFT_SIZE;
        total++;
        if (++sinceFrame === hop) {
          sinceFrame = 0;
          emitBandFrame();
        }
      }
    },
    finish() {
      flushPeakBlock();
      let max = 0;
      for (const f of rawBands) for (const v of f) if (v > max) max = v;
      const bands = rawBands.map((f) => f.map((v) => (max > 0 ? round3(v / max) : 0)));
      return {
        version: WAVEFORM_VERSION,
        duration: round3(total / sampleRate),
        peaks: downsamplePeaks(pairs, PEAKS_BUCKETS).map(round3),
        frameRate: BAND_FRAME_RATE,
        bands,
      };
    },
  };
}
