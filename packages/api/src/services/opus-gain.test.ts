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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  gainForTarget,
  oggPageCrc,
  readOggOpusDurationSec,
  readOutputGain,
  writeOutputGain,
} from './opus-gain.js';
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

  it('touches only the head of a file far larger than the read window', () => {
    // The regression. `readFileSync(p).subarray(0, 65536)` reads the WHOLE
    // track and throws it away; over 7,774 library files that was 43.8 GiB of
    // synchronous reads, which blocked the event loop long enough for health
    // checks to time out and the container to be marked unhealthy on prod.
    // A 30 s Opus file is comfortably past the 64 KiB window.
    const root = tmpRoot();
    const p = join(root, 'long.opus');
    makeOpus(p, 30);
    const before = readFileSync(p);
    expect(before.length).toBeGreaterThan(65_536);

    expect(writeOutputGain(p, -4)).toBe(true);

    const after = readFileSync(p);
    expect(after.length).toBe(before.length);
    expect(readOutputGain(p)).toBe(-4);
    // Everything past the first page is untouched, which is what makes an
    // in-place six-byte patch equivalent to the old whole-file rewrite.
    expect(after.subarray(65_536).equals(before.subarray(65_536))).toBe(true);
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

/** ffprobe's container duration, the probe the in-process reader replaces. */
function ffprobeDuration(path: string): number {
  return Number(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path],
      { encoding: 'utf-8' },
    ),
  );
}

/** Byte offset of the last `OggS` capture pattern — the start of the final page. */
function lastPageAt(buf: Buffer): number {
  return buf.lastIndexOf('OggS');
}

describe.skipIf(!ffmpegAvailable())('readOggOpusDurationSec', () => {
  it.skipIf(!tool('ffprobe'))(
    'matches ffprobe within 10 ms and the encoded length within 1 ms, across lengths',
    async () => {
      const root = tmpRoot();
      for (const seconds of [0.3, 1, 7.77, 61.3, 183.21]) {
        const p = join(root, `t${seconds}.opus`);
        makeOpus(p, seconds);
        const mine = await readOggOpusDurationSec(p);
        expect(mine).not.toBeNull();
        expect(mine).not.toBeUndefined();
        // ffprobe reports the pre-skip too (312 samples = 6.5 ms); the granule
        // minus pre-skip is the playable length the encoder was given.
        expect(Math.abs(mine! - ffprobeDuration(p))).toBeLessThan(0.01);
        expect(Math.abs(mine! - seconds)).toBeLessThan(0.001);
      }
    },
  );

  it('is null (fail closed) for a file truncated anywhere after its head', async () => {
    const root = tmpRoot();
    const p = join(root, 'full.opus');
    makeOpus(p, 5);
    const full = readFileSync(p);
    for (const keep of [full.length - 1, full.length - 200, Math.floor(full.length / 2), 400]) {
      const cut = join(root, `cut${keep}.opus`);
      writeFileSync(cut, full.subarray(0, keep));
      expect(await readOggOpusDurationSec(cut)).toBeNull();
    }
  });

  it('is null for trailing bytes after the last page', async () => {
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);
    writeFileSync(p, Buffer.concat([readFileSync(p), Buffer.from('garbage')]));
    expect(await readOggOpusDurationSec(p)).toBeNull();
  });

  it('is null when the last page fails its CRC', async () => {
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);
    const buf = readFileSync(p);
    buf[buf.length - 1] ^= 0xff;
    writeFileSync(p, buf);
    expect(await readOggOpusDurationSec(p)).toBeNull();
  });

  it('is null when the head page fails its CRC', async () => {
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);
    const buf = readFileSync(p);
    buf[27 + buf[26]! + 9] ^= 0x01; // the channel count inside OpusHead
    writeFileSync(p, buf);
    expect(await readOggOpusDurationSec(p)).toBeNull();
  });

  it('is null when the last page is not flagged end-of-stream', async () => {
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);
    const buf = readFileSync(p);
    const at = lastPageAt(buf);
    buf[at + 5] &= ~0x04;
    const page = buf.subarray(at);
    page.writeUInt32LE(oggPageCrc(page), 22); // a valid page, just not the end
    writeFileSync(p, buf);
    expect(await readOggOpusDurationSec(p)).toBeNull();
  });

  it('is null when the last page belongs to another logical stream', async () => {
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);
    const buf = readFileSync(p);
    const at = lastPageAt(buf);
    buf.writeUInt32LE(buf.readUInt32LE(at + 14) ^ 1, at + 14);
    const page = buf.subarray(at);
    page.writeUInt32LE(oggPageCrc(page), 22);
    writeFileSync(p, buf);
    expect(await readOggOpusDurationSec(p)).toBeNull();
  });

  it('is null for a file holding only its OpusHead page (no audio pages)', async () => {
    const root = tmpRoot();
    const p = join(root, 'a.opus');
    makeOpus(p, 2);
    const buf = readFileSync(p);
    let headLength = 27 + buf[26]!;
    for (let i = 0; i < buf[26]!; i++) headLength += buf[27 + i]!;
    writeFileSync(p, buf.subarray(0, headLength));
    expect(await readOggOpusDurationSec(p)).toBeNull();
  });

  it('is undefined — use another probe — for anything that is not Ogg-Opus', async () => {
    const root = tmpRoot();
    const empty = join(root, 'empty.opus');
    writeFileSync(empty, Buffer.alloc(0));
    const text = join(root, 'text.opus');
    writeFileSync(text, 'this is not an ogg file');
    const flac = join(root, 'a.flac');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'sine=d=1', '-y', flac]);
    for (const p of [empty, text, flac, join(root, 'missing.opus')]) {
      expect(await readOggOpusDurationSec(p)).toBeUndefined();
    }
  });
});
