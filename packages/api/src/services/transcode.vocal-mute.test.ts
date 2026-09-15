import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegAvailable, transcodeToFile, MID_RESIDUAL } from './transcode.js';
import { ffmpegBinary } from './ffmpeg-path.js';

/**
 * Real-ffmpeg contract for the karaoke vocal-mute filter (issues #602, #1042).
 *
 * Synthesises stereo mixes with a dead-centre "vocal" (in both channels) and a
 * side-panned "instrument" (opposite polarity in L and R), runs them through the
 * exact `transcodeToFile(..., vocalRemoval = true)` path a `?vocals=off` stream
 * takes, and measures the result. `transcode.test.ts` mocks child_process, so
 * the filter's audible behaviour can only be pinned here.
 */

const SAMPLE_RATE = 44_100;
const SECONDS = 2;
const CENTRE_AMPLITUDE = 0.4; // the "vocal": identical in L and R
const SIDE_AMPLITUDE = 0.2; // the "instrument": +s in L, -s in R
const BASS_AMPLITUDE = 0.3; // a centred 60 Hz bass, below the vocal band
const BASS_HZ = 60;

function sideRmsDbfs(): number {
  return 20 * Math.log10(SIDE_AMPLITUDE / Math.SQRT2);
}

/** L = centre + side (+ optional centred bass), R = centre − side (+ bass), 16-bit PCM WAV. */
function writeSyntheticStereoWav(path: string, bassAmplitude = 0): void {
  const frames = SAMPLE_RATE * SECONDS;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const centre = CENTRE_AMPLITUDE * Math.sin(2 * Math.PI * 440 * t);
    const side = SIDE_AMPLITUDE * Math.sin(2 * Math.PI * 660 * t);
    const bass = bassAmplitude * Math.sin(2 * Math.PI * BASS_HZ * t);
    data.writeInt16LE(Math.round((centre + bass + side) * 32767), i * 4);
    data.writeInt16LE(Math.round((centre + bass - side) * 32767), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(2, 22); // channels
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/** Decode with ffmpeg to float samples; `channels: 1` is ffmpeg's own L/R downmix. */
function decode(path: string, channels: 1 | 2): Float32Array {
  const raw = execFileSync(
    ffmpegBinary(),
    [
      '-v',
      'error',
      '-i',
      path,
      '-f',
      'f32le',
      '-ac',
      String(channels),
      '-ar',
      String(SAMPLE_RATE),
      '-',
    ],
    { maxBuffer: 64 * 1024 * 1024 },
  );
  return new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function rmsDbfs(samples: Float32Array): number {
  let sum = 0;
  for (const s of samples) sum += s * s;
  return 20 * Math.log10(Math.sqrt(sum / samples.length) || 1e-12);
}

const deinterleave = (stereo: Float32Array, ch: 0 | 1): Float32Array =>
  stereo.filter((_, i) => i % 2 === ch);

/** Pointwise (a ± b)/2 — the mid (centre) and side content of a channel pair. */
function midSide(stereo: Float32Array, which: 'mid' | 'side'): Float32Array {
  const left = deinterleave(stereo, 0);
  const right = deinterleave(stereo, 1);
  const out = new Float32Array(left.length);
  for (let i = 0; i < left.length; i++) {
    out[i] = which === 'mid' ? (left[i]! + right[i]!) / 2 : (left[i]! - right[i]!) / 2;
  }
  return out;
}

/**
 * Level of one tone, via a single-bin DFT over a whole number of cycles. Skips
 * 0.25 s at each end so the encoder's leading padding cannot drag the average
 * down, which a broadband RMS could not distinguish from real attenuation.
 */
function toneDbfs(mono: Float32Array, hz: number): number {
  const period = SAMPLE_RATE / hz;
  const start = Math.round(SAMPLE_RATE * 0.25);
  const cycles = Math.floor((mono.length - 2 * start) / period);
  const n = Math.round(cycles * period);
  let re = 0;
  let im = 0;
  for (let i = 0; i < n; i++) {
    const phase = (2 * Math.PI * hz * i) / SAMPLE_RATE;
    re += mono[start + i]! * Math.cos(phase);
    im += mono[start + i]! * Math.sin(phase);
  }
  return 20 * Math.log10((2 * Math.hypot(re, im)) / n || 1e-12);
}

describe('vocal-mute filter (real ffmpeg)', () => {
  let dir = '';
  let src = '';
  let outPath = '';
  let bassSrc = '';
  let bassOut = '';

  beforeAll(async () => {
    if (!ffmpegAvailable()) return;
    dir = mkdtempSync(join(tmpdir(), 'nicotind-vocal-mute-'));
    src = join(dir, 'mix.wav');
    writeSyntheticStereoWav(src);
    outPath = join(dir, 'muted.mp3');
    await transcodeToFile(src, outPath, 'mp3', 192, true);
    // A second mix with a centred bass below the vocal band, for #1042.
    bassSrc = join(dir, 'mix-bass.wav');
    writeSyntheticStereoWav(bassSrc, BASS_AMPLITUDE);
    bassOut = join(dir, 'muted-bass.mp3');
    await transcodeToFile(bassSrc, bassOut, 'mp3', 192, true);
  });

  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!ffmpegAvailable())(
    'a mono downmix of the muted stream is audible, not digital silence (#602)',
    () => {
      const monoDb = rmsDbfs(decode(outPath, 1));
      // Anti-phase channels sum to exactly zero (measured -120 dBFS in the
      // spike); an in-phase result lands within a few dB of the side signal.
      // Both tones in this mix are inside the vocal band, so the guard still
      // measures the mid residual and not an untouched band passing through.
      expect(monoDb).toBeGreaterThan(-40);
    },
  );

  it.skipIf(!ffmpegAvailable())('keeps the stereo image and attenuates the centre', () => {
    const stereo = decode(outPath, 2);
    // A real stereo pair, not one mono difference written twice: the side
    // survives at its own level, so (L−R)/2 still recovers the instrument.
    expect(rmsDbfs(midSide(stereo, 'side'))).toBeCloseTo(sideRmsDbfs(), 0);
    // ...and the centre is attenuated to MID_RESIDUAL rather than cancelled.
    const centreDrop = rmsDbfs(midSide(stereo, 'mid')) - rmsDbfs(midSide(decode(src, 2), 'mid'));
    expect(centreDrop).toBeCloseTo(20 * Math.log10(MID_RESIDUAL), 0);
  });

  it.skipIf(!ffmpegAvailable())('keeps a centred bass below the vocal band (#1042)', () => {
    // The harm the band limit exists to fix: the full-band predecessor removed
    // every centred bass note with the voice (-9.35 dB of sub-bass measured on
    // a real track, and total cancellation on this synthetic one).
    const before = toneDbfs(decode(bassSrc, 1), BASS_HZ);
    const after = toneDbfs(decode(bassOut, 1), BASS_HZ);
    expect(after - before).toBeGreaterThan(-3);
  });
});
