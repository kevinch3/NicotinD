/**
 * Tests for Opus header-gain normalization.
 *
 * This edits bytes inside real library files, so the bar is higher than "our
 * reader agrees with our writer". Two independent readers are asked whether
 * the result is a valid file — `opusinfo` and `ffprobe` — because a wrong page
 * CRC produces a file that our own parser still reads happily and every
 * decoder rejects. That is the failure this suite exists to catch.
 *
 * Verified that those readers actually catch it, rather than assuming: patching
 * the gain bytes WITHOUT recomputing the CRC makes both `ffprobe` and
 * `opusinfo` exit non-zero. So these assertions fail on the mistake they are
 * written to prevent.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gainForTarget, oggPageCrc, readOutputGain, writeOutputGain } from './opus-gain.js';
import { ffmpegAvailable } from './transcode.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'nicotind-gain-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function makeOpus(path: string, seconds = 1): void {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
      '-vn',
      '-c:a',
      'libopus',
      '-b:a',
      '96k',
      '-f',
      'ogg',
      '-y',
      path,
    ],
    { stdio: 'ignore' },
  );
}

function tool(bin: string): boolean {
  try {
    execFileSync('which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** What `opusinfo` reports, which is not our parser's opinion. */
function opusinfoGain(path: string): string {
  const out = execFileSync('opusinfo', [path], { encoding: 'utf-8', stdio: 'pipe' });
  return out;
}

describe('gainForTarget', () => {
  it('computes the difference to the target', () => {
    // The library's median is −10.1 LUFS and the chosen target is −14, so most
    // of the library comes down a few dB.
    expect(gainForTarget(-10, -14)).toBe(-4);
    expect(gainForTarget(-20, -14)).toBe(6);
    expect(gainForTarget(-14, -14)).toBe(0);
  });

  it('declines a missing measurement instead of assuming one', () => {
    // A track with no loudness reading must be left alone. Writing a gain from
    // a default would be a confident wrong answer, and a normalized-to-nothing
    // track is worse than an unnormalized one.
    for (const bad of [null, undefined, NaN]) expect(gainForTarget(bad, -14)).toBeNull();
  });

  it('declines an implausible measurement', () => {
    // Real integrated loudness for music sits roughly between −40 and 0 LUFS.
    expect(gainForTarget(5, -14)).toBeNull();
    expect(gainForTarget(-200, -14)).toBeNull();
  });

  it('clamps rather than emitting a deafening or silent gain', () => {
    expect(gainForTarget(-59, -14)).toBe(32);
    expect(gainForTarget(-0.5, 40)).toBe(32);
  });
});

describe('oggPageCrc', () => {
  it('ignores the existing CRC field when summing', () => {
    // Bytes 22-25 are the CRC itself and must be treated as zero, or the sum
    // depends on what it is trying to compute.
    const a = Buffer.alloc(40, 7);
    const b = Buffer.from(a);
    b.writeUInt32LE(0xdeadbeef, 22);
    expect(oggPageCrc(a)).toBe(oggPageCrc(b));
  });
});

describe.skipIf(!ffmpegAvailable())('writeOutputGain', () => {
  it('round-trips a gain through the header', () => {
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p);
    expect(readOutputGain(p)).toBe(0);

    expect(writeOutputGain(p, -4)).toBe(true);

    expect(readOutputGain(p)).toBe(-4);
  });

  it('changes exactly six bytes: two of gain, four of CRC', () => {
    // The claim this whole approach rests on. If more than six bytes move,
    // something is re-encoding and the "lossless" framing is false.
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);
    const before = readFileSync(p);

    writeOutputGain(p, -6);

    const after = readFileSync(p);
    expect(after.length).toBe(before.length);
    let differing = 0;
    for (let i = 0; i < before.length; i++) if (before[i] !== after[i]) differing++;
    expect(differing).toBeLessThanOrEqual(6);
    expect(differing).toBeGreaterThan(0);
  });

  it('leaves the audio identical', () => {
    // Everything after the first page must be byte-for-byte unchanged.
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);
    const before = readFileSync(p);

    writeOutputGain(p, 8);

    const after = readFileSync(p);
    expect(after.subarray(100).equals(before.subarray(100))).toBe(true);
  });

  it('is reversible by writing zero back', () => {
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p);
    const original = readFileSync(p);

    writeOutputGain(p, -7);
    writeOutputGain(p, 0);

    expect(readFileSync(p).equals(original)).toBe(true);
  });

  it.skipIf(!tool('ffprobe'))('leaves a file ffprobe still accepts', () => {
    // A wrong page CRC produces a file our own parser reads happily and every
    // decoder rejects. Our reader agreeing with our writer proves nothing.
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);

    writeOutputGain(p, -4);

    const out = execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1', p],
      { encoding: 'utf-8', stdio: 'pipe' },
    );
    expect(out).toContain('duration=');
  });

  it.skipIf(!tool('opusinfo'))('leaves a file opusinfo still accepts', () => {
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);

    writeOutputGain(p, -4);

    // opusinfo exits non-zero and says so on a bad CRC; reaching here at all
    // means the page validated.
    expect(opusinfoGain(p)).toContain('Opus');
  });

  it('declines a file that is not Ogg-Opus rather than corrupting it', () => {
    const root = tmpRoot();
    const p = join(root, 'not-audio.opus');
    Bun.write(p, 'this is not an ogg file');

    expect(writeOutputGain(p, -4)).toBe(false);
    expect(readOutputGain(p)).toBeNull();
  });

  it('declines a missing file', () => {
    expect(writeOutputGain('/nope/missing.opus', -4)).toBe(false);
    expect(readOutputGain('/nope/missing.opus')).toBeNull();
  });
});
