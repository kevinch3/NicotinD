import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { transcodeToFile } from './transcode.js';

/**
 * Real-audio validation of the vocal-removal filter. The unit tests in
 * transcode.test.ts only check that the right args are spawned — they can't
 * tell whether the filter actually removes vocals. This file spawns real ffmpeg
 * against synthetic test signals and measures the result.
 *
 * Skipped if ffmpeg isn't on PATH.
 */

const tmpDir = mkdtempSync(join(tmpdir(), 'nd-vocal-test-'));

// 2-second 440Hz sine wave identical in both channels (perfectly center-panned).
const CENTER_SINE = join(tmpDir, 'center-sine.mp3');
// 2-second 440Hz sine in left channel only, silence in right (purely left-panned).
const SIDE_SINE = join(tmpDir, 'side-sine.mp3');

function makeCenterSine(): void {
  spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=2',
      '-ac', '2',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      CENTER_SINE,
    ],
    { stdio: 'ignore' },
  );
}

function makeSideSine(): void {
  // Left channel: 440Hz sine. Right channel: silence.
  spawnSync(
    'ffmpeg',
    [
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=2',
      '-f', 'lavfi',
      '-i', 'anullsrc=r=44100:cl=mono',
      '-filter_complex', '[0:a][1:a]amerge=inputs=2',
      '-ac', '2',
      '-c:a', 'libmp3lame',
      '-b:a', '128k',
      SIDE_SINE,
    ],
    { stdio: 'ignore' },
  );
}

function rmsOf(file: string): number {
  const out = spawnSync('ffmpeg', ['-hide_banner', '-i', file, '-af', 'volumedetect', '-vn', '-f', 'null', '-'], {
    encoding: 'utf8',
  });
  const match = /mean_volume:\s*([-\d.]+)\s*dB/.exec(out.stderr);
  if (!match) throw new Error(`volumedetect failed for ${file}: ${out.stderr}`);
  return Number(match[1]);
}

describe('vocal removal filter — real ffmpeg', () => {
  let ffmpegOk = false;

  beforeAll(() => {
    try {
      execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
      ffmpegOk = true;
    } catch {
      // ffmpeg missing — tests will be skipped.
    }
    if (!ffmpegOk) return;
    makeCenterSine();
    makeSideSine();
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cancels a perfectly center-panned signal by ≥40 dB', async () => {
    if (!ffmpegOk) return;
    const out = join(tmpDir, 'out-center.opus');
    await transcodeToFile(CENTER_SINE, out, 'opus', 128, true);
    const originalRms = rmsOf(CENTER_SINE);
    const vocalRemovedRms = rmsOf(out);
    const reduction = originalRms - vocalRemovedRms;
    // The center sine must be attenuated by at least 40 dB.
    // Anything less means the filter isn't doing anything.
    expect(reduction).toBeGreaterThanOrEqual(40);
  }, 30_000);

  it('preserves a purely left-panned signal (not cancelled)', async () => {
    if (!ffmpegOk) return;
    const out = join(tmpDir, 'out-side.opus');
    await transcodeToFile(SIDE_SINE, out, 'opus', 128, true);
    const originalRms = rmsOf(SIDE_SINE);
    const vocalRemovedRms = rmsOf(out);
    // The side-panned signal should NOT be cancelled — the reduction must
    // be small (< 15 dB; the filter only subtracts correlation between channels,
    // and a pure side signal has zero correlation).
    const reduction = originalRms - vocalRemovedRms;
    expect(reduction).toBeLessThan(15);
  }, 30_000);

  it('omits the -af filter when vocalRemoval is false', async () => {
    if (!ffmpegOk) return;
    const out = join(tmpDir, 'out-passthrough.opus');
    await transcodeToFile(CENTER_SINE, out, 'opus', 128, false);
    const originalRms = rmsOf(CENTER_SINE);
    const passthroughRms = rmsOf(out);
    // Without vocalRemoval, output should match input (no filter applied).
    expect(Math.abs(originalRms - passthroughRms)).toBeLessThan(1);
  }, 30_000);
});