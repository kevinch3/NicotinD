import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ffmpegAvailable, transcodeToFile } from './transcode.js';
import { ffmpegBinary } from './ffmpeg-path.js';

/**
 * Real-ffmpeg contract for the karaoke vocal-mute filter (issue #602).
 *
 * Synthesises a stereo mix with a dead-centre "vocal" (in both channels) and a
 * side-panned "instrument" (opposite polarity in L and R), runs it through the
 * exact `transcodeToFile(..., vocalRemoval = true)` path a `?vocals=off` stream
 * takes, and measures the result. `transcode.test.ts` mocks child_process, so
 * the filter's audible behaviour can only be pinned here.
 */

const SAMPLE_RATE = 44_100;
const SECONDS = 2;
const CENTRE_AMPLITUDE = 0.4; // the "vocal": identical in L and R
const SIDE_AMPLITUDE = 0.2; // the "instrument": +s in L, -s in R

function sideRmsDbfs(): number {
  return 20 * Math.log10(SIDE_AMPLITUDE / Math.SQRT2);
}

/** L = centre + side, R = centre - side, 16-bit PCM WAV. */
function writeSyntheticStereoWav(path: string): void {
  const frames = SAMPLE_RATE * SECONDS;
  const data = Buffer.alloc(frames * 4);
  for (let i = 0; i < frames; i++) {
    const t = i / SAMPLE_RATE;
    const centre = CENTRE_AMPLITUDE * Math.sin(2 * Math.PI * 440 * t);
    const side = SIDE_AMPLITUDE * Math.sin(2 * Math.PI * 660 * t);
    data.writeInt16LE(Math.round((centre + side) * 32767), i * 4);
    data.writeInt16LE(Math.round((centre - side) * 32767), i * 4 + 2);
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

describe('vocal-mute filter (real ffmpeg)', () => {
  let dir = '';
  let outPath = '';

  beforeAll(async () => {
    if (!ffmpegAvailable()) return;
    dir = mkdtempSync(join(tmpdir(), 'nicotind-vocal-mute-'));
    const wav = join(dir, 'mix.wav');
    writeSyntheticStereoWav(wav);
    outPath = join(dir, 'muted.mp3');
    await transcodeToFile(wav, outPath, 'mp3', 192, true);
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
      expect(monoDb).toBeGreaterThan(-40);
    },
  );

  it.skipIf(!ffmpegAvailable())('keeps the side-panned instrument and removes the centre', () => {
    const stereo = decode(outPath, 2);
    const left = stereo.filter((_, i) => i % 2 === 0);
    const right = stereo.filter((_, i) => i % 2 === 1);
    // Each output channel is (L−R)/2 = side, at the side signal's own level —
    // the 0.5 gain keeps L−R (which peaks above 0 dBFS on most real mixes)
    // out of the encoder's clipper. Any centre leakage would read ~+9 dB.
    const expected = sideRmsDbfs();
    expect(rmsDbfs(left)).toBeCloseTo(expected, 0);
    expect(rmsDbfs(right)).toBeCloseTo(expected, 0);
  });
});
