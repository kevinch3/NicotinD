/**
 * The Opus-artwork harness.
 *
 * Exists because ad-hoc probing got this wrong twice (#1226): once concluding
 * ffmpeg could carry the picture when it could not reproduce, once blaming the
 * writer when the writer was correct and our reader was not.
 *
 * So it uses real tools on real images at several sizes, and asks **two**
 * readers — `opusinfo`, which is opus-tools' own and therefore the authority on
 * whether the file is right, and `music-metadata`, which is what every read
 * path in this app actually uses. Keeping those separate is the entire point:
 * "the file is wrong" and "we cannot read a correct file" need opposite fixes.
 *
 * Needs `opus-tools`, which the `ci` job does not have — the describes are
 * guarded, never the individual cases, so a test added later inherits it.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ffmpegAvailable } from './transcode.js';
import { MAX_EMBEDDED_PICTURE_BYTES, preparePicture } from './opus-artwork.js';
import {
  encodeWithPicture,
  makeCover,
  makeMp3WithCover,
  makeWav,
  opusencAvailable,
  opusinfoAvailable,
  opusinfoPictureBytes,
} from './opus-artwork.fixtures.js';
import { getMusicMetadata } from './music-metadata-loader.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), 'opus-art-'));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function readWithMusicMetadata(opusPath: string): Promise<number | null> {
  const mm = await getMusicMetadata();
  if (!mm) return null;
  try {
    const m = await mm.parseFile(opusPath);
    return m.common.picture?.[0]?.data?.length ?? null;
  } catch {
    return null; // the throw IS the finding; the caller asserts on it
  }
}

const TOOLS = ffmpegAvailable() && opusencAvailable() && opusinfoAvailable();

describe.skipIf(!TOOLS)('opusenc writes a correct picture block', () => {
  it('round-trips a cover byte-exact, at a size our reader handles', async () => {
    const d = scratch();
    const cover = join(d, 'cover.jpg');
    const wav = join(d, 'a.wav');
    const out = join(d, 'a.opus');
    const bytes = makeCover(cover, 400);
    makeWav(wav);

    encodeWithPicture(wav, cover, out);

    // opus-tools' own reader: is the FILE right?
    expect(opusinfoPictureBytes(out)).toBe(bytes);
    // ours: can the app see it?
    expect(await readWithMusicMetadata(out)).toBe(bytes);
  });

  it('writes a correct file even when our reader cannot read it', async () => {
    // The finding the first spike inverted. A big cover produces a VALID file
    // — opusinfo reads it back byte-exact — that music-metadata throws on. The
    // writer was never the problem.
    const d = scratch();
    const cover = join(d, 'big.jpg');
    const wav = join(d, 'a.wav');
    const out = join(d, 'a.opus');
    const bytes = makeCover(cover, 1100, 2);
    expect(bytes).toBeGreaterThan(MAX_EMBEDDED_PICTURE_BYTES);
    makeWav(wav);

    encodeWithPicture(wav, cover, out);

    expect(opusinfoPictureBytes(out)).toBe(bytes); // file: correct
    expect(await readWithMusicMetadata(out)).toBeNull(); // reader: cannot
  });
});

describe.skipIf(!TOOLS)("the ceiling is ours, not Opus's", () => {
  it('reads the same oversized image fine from an mp3', async () => {
    // Which is what makes this a reader limitation specific to Opus rather
    // than anything about the image.
    const d = scratch();
    const cover = join(d, 'big.jpg');
    const mp3 = join(d, 'big.mp3');
    const bytes = makeCover(cover, 1100, 2);
    makeMp3WithCover(mp3, cover);

    const mm = await getMusicMetadata();
    const got = (await mm!.parseFile(mp3)).common.picture?.[0]?.data?.length;
    expect(got).toBe(bytes);
  });
});

describe.skipIf(!ffmpegAvailable())('preparePicture keeps covers under the cap', () => {
  it('passes a small cover through untouched', () => {
    const d = scratch();
    const cover = join(d, 'small.jpg');
    const bytes = makeCover(cover, 300);
    expect(bytes).toBeLessThan(MAX_EMBEDDED_PICTURE_BYTES);

    const p = preparePicture(cover, join(d, 'scratch.jpg'));

    // The common case must not pay for a second encode.
    expect(p?.recompressed).toBe(false);
    expect(p?.path).toBe(cover);
  });

  it('re-compresses an oversized cover to fit', () => {
    // 900px of noise: over the cap at q2, and compressible enough that the
    // quality ladder can rescue it. Real covers are photographs and compress
    // far better than noise, so this is the harder end of realistic.
    const d = scratch();
    const cover = join(d, 'big.jpg');
    const bytes = makeCover(cover, 900, 2);
    expect(bytes).toBeGreaterThan(MAX_EMBEDDED_PICTURE_BYTES);

    const p = preparePicture(cover, join(d, 'scratch.jpg'));

    expect(p?.recompressed).toBe(true);
    expect(p!.bytes).toBeLessThanOrEqual(MAX_EMBEDDED_PICTURE_BYTES);
  });

  it('returns null rather than a path when nothing gets under the cap', () => {
    // Pure noise at 1400px is incompressible by construction — no real cover
    // looks like this, but the caller still needs an explicit "do not embed"
    // instead of a path that blows up in the encoder later.
    const d = scratch();
    const cover = join(d, 'huge.jpg');
    makeCover(cover, 1400, 1);

    expect(preparePicture(cover, join(d, 'scratch.jpg'))).toBeNull();
  });

  it.skipIf(!TOOLS)('and what it produces is readable by the app', async () => {
    // The assertion that matters: the cap is only worth anything if a capped
    // cover survives the round trip our own reader performs.
    const d = scratch();
    const cover = join(d, 'big.jpg');
    const wav = join(d, 'a.wav');
    const out = join(d, 'a.opus');
    makeCover(cover, 900, 2);
    makeWav(wav);

    const p = preparePicture(cover, join(d, 'scratch.jpg'));
    expect(p).not.toBeNull();
    encodeWithPicture(wav, p!.path, out);

    expect(await readWithMusicMetadata(out)).toBe(p!.bytes);
  });
});

describe('the cap itself', () => {
  it('sits under the measured boundary with margin', () => {
    // music-metadata read 598,039 and threw on 676,153. The cap is not set AT
    // the boundary: the exact figure is a property of a dependency we do not
    // control, and it can move on an upgrade.
    expect(MAX_EMBEDDED_PICTURE_BYTES).toBeLessThan(598_039);
  });
});
