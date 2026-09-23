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
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ffmpegAvailable } from './transcode.js';
import {
  attachPictureToOpus,
  MAX_EMBEDDED_PICTURE_BYTES,
  pictureBlockBase64,
  preparePicture,
} from './opus-artwork.js';
import {
  encodeWithPicture,
  imageDimensions,
  makeCover,
  makeMp3WithCover,
  makeWav,
  nativeQualityBytes,
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
  it('passes a small cover through untouched', async () => {
    const d = scratch();
    const cover = join(d, 'small.jpg');
    const bytes = makeCover(cover, 300);
    expect(bytes).toBeLessThan(MAX_EMBEDDED_PICTURE_BYTES);

    const p = await preparePicture(cover, join(d, 'scratch.jpg'));

    // The common case must not pay for a second encode.
    expect(p?.recompressed).toBe(false);
    expect(p?.path).toBe(cover);
  });

  it('re-compresses an oversized cover to fit', async () => {
    // 900px of noise: over the cap at q2, and compressible enough that the
    // quality ladder can rescue it. Real covers are photographs and compress
    // far better than noise, so this is the harder end of realistic.
    const d = scratch();
    const cover = join(d, 'big.jpg');
    const bytes = makeCover(cover, 900, 2);
    expect(bytes).toBeGreaterThan(MAX_EMBEDDED_PICTURE_BYTES);

    const p = await preparePicture(cover, join(d, 'scratch.jpg'));

    expect(p?.recompressed).toBe(true);
    expect(p!.bytes).toBeLessThanOrEqual(MAX_EMBEDDED_PICTURE_BYTES);
  });

  it('downscales when no quality reaches the cap', async () => {
    // #1252. 1100px of noise is over the cap at EVERY quality the ladder will
    // try, so before the edge ladder existed this cover was dropped outright.
    // Real covers hit the same wall at larger dimensions — the one that found
    // this was 3000×3000 and 605 KB at q8.
    const d = scratch();
    const cover = join(d, 'wide.jpg');
    const bytes = makeCover(cover, 1100, 2);
    expect(bytes).toBeGreaterThan(MAX_EMBEDDED_PICTURE_BYTES);
    // Assert the denominator: this fixture is only a regression test for as
    // long as quality alone genuinely cannot rescue it. q8 is the softest rung.
    expect(nativeQualityBytes(cover, 8)).toBeGreaterThan(MAX_EMBEDDED_PICTURE_BYTES);

    const p = await preparePicture(cover, join(d, 'scratch.jpg'));

    expect(p).not.toBeNull();
    expect(p!.bytes).toBeLessThanOrEqual(MAX_EMBEDDED_PICTURE_BYTES);
    // And it fits by giving up as little as possible: the first edge rung that
    // works, not the smallest one. A fix that shrank every oversized cover to
    // a thumbnail would also satisfy the assertion above.
    expect(Math.max(...imageDimensions(p!.path))).toBeGreaterThanOrEqual(1000);
  });

  it('returns null when the input is not a decodable image', async () => {
    // The null contract still matters, but it is no longer reachable by size:
    // the 1000px rung brings any decodable image under the cap (square noise,
    // the worst case there is, lands ~385 KB there whatever its source size).
    // What remains is a cover that ffmpeg cannot read at all, and the caller
    // needs an explicit "do not embed" rather than a path that fails later.
    const d = scratch();
    const cover = join(d, 'not-an-image.jpg');
    writeFileSync(cover, Buffer.alloc(900 * 1024, 0x7f));

    expect(await preparePicture(cover, join(d, 'scratch.jpg'))).toBeNull();
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

    const p = await preparePicture(cover, join(d, 'scratch.jpg'));
    expect(p).not.toBeNull();
    encodeWithPicture(wav, p!.path, out);

    expect(await readWithMusicMetadata(out)).toBe(p!.bytes);
  });
});

describe.skipIf(!TOOLS)('merging one field into a tagged file', () => {
  /** The merge `attachPictureToOpus` performs, with whatever ffmetadata is given. */
  function mergeMetadata(src: string, out: string, lines: string[]): void {
    const meta = join(dirname(out), 'merge.ffmeta');
    writeFileSync(meta, [';FFMETADATA1', ...lines].join('\n') + '\n');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        src,
        '-f',
        'ffmetadata',
        '-i',
        meta,
        '-map',
        '0:a',
        '-map_metadata',
        '1',
        '-c:a',
        'copy',
        '-f',
        'ogg',
        '-y',
        out,
      ],
      { stdio: 'pipe' },
    );
  }

  it('keeps the scalar comments but DROPS an existing picture', async () => {
    // The trap, pinned. The docstring's "`-c:a copy` preserves the existing
    // tags" is true of scalars and false of the cover: ffmpeg surfaces
    // METADATA_BLOCK_PICTURE as an attached-picture stream, so `-map 0:a`
    // excludes it. `attachPictureToOpus` never meets this because it always
    // writes a picture; a caller merging some other field silently strips one.
    // Measured on a real repair before it touched 32 library files.
    const d = scratch();
    const cover = join(d, 'c.jpg');
    const wav = join(d, 'a.wav');
    const tagged = join(d, 'tagged.opus');
    const out = join(d, 'out.opus');
    const bytes = makeCover(cover, 400);
    makeWav(wav);
    encodeWithPicture(wav, cover, tagged);
    expect(await readWithMusicMetadata(tagged)).toBe(bytes);

    mergeMetadata(tagged, out, ['MUSICBRAINZ_TRACKID=4f6edf56-d83b-4d8f-b216-2b17c2a9daab']);

    const m = await getMusicMetadata();
    const after = await m!.parseFile(out);
    // The field asked for arrives...
    expect((after.common as Record<string, unknown>).musicbrainz_recordingid).toBeTruthy();
    // ...and the cover nobody mentioned is gone.
    expect(after.common.picture?.length ?? 0).toBe(0);
  });

  it('preserves the picture when the merge re-writes it explicitly', async () => {
    // The remedy, and the shape any one-field merge has to use.
    const d = scratch();
    const cover = join(d, 'c.jpg');
    const wav = join(d, 'a.wav');
    const tagged = join(d, 'tagged.opus');
    const out = join(d, 'out.opus');
    const bytes = makeCover(cover, 400);
    makeWav(wav);
    encodeWithPicture(wav, cover, tagged);

    const m = await getMusicMetadata();
    const pic = (await m!.parseFile(tagged)).common.picture![0]!;
    mergeMetadata(tagged, out, [
      'METADATA_BLOCK_PICTURE=' +
        pictureBlockBase64(Buffer.from(pic.data), pic.format || 'image/jpeg').replace(
          /[=;#\\\n]/g,
          (c) => '\\' + c,
        ),
      'MUSICBRAINZ_TRACKID=4f6edf56-d83b-4d8f-b216-2b17c2a9daab',
    ]);

    const after = await m!.parseFile(out);
    expect((after.common as Record<string, unknown>).musicbrainz_recordingid).toBeTruthy();
    expect(after.common.picture?.[0]?.data?.length).toBe(bytes);
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

describe.skipIf(!ffmpegAvailable())('attachPictureToOpus — no re-encode, no new dependency', () => {
  /** A tagged .opus the way the real encode produces one. */
  function taggedOpus(d: string, tags: Record<string, string>): string {
    const wav = join(d, 'src.wav');
    const out = join(d, 'tagged.opus');
    makeWav(wav);
    const meta = Object.entries(tags).flatMap(([k, v]) => ['-metadata', `${k}=${v}`]);
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        wav,
        '-vn',
        ...meta,
        '-c:a',
        'libopus',
        '-b:a',
        '96k',
        '-f',
        'ogg',
        '-y',
        out,
      ],
      { stdio: 'ignore' },
    );
    return out;
  }

  async function vorbisTags(p: string): Promise<Record<string, string>> {
    const mm = await getMusicMetadata();
    const m = await mm!.parseFile(p);
    const native = (m.native as Record<string, Array<{ id: string; value: unknown }>>).vorbis ?? [];
    return Object.fromEntries(
      native.filter((t) => t.id !== 'METADATA_BLOCK_PICTURE').map((t) => [t.id, String(t.value)]),
    );
  }

  it('attaches a cover the app can read back, byte-exact', async () => {
    const d = scratch();
    const opus = taggedOpus(d, { ARTIST: 'A' });
    const cover = join(d, 'c.jpg');
    const bytes = makeCover(cover, 500, 4);

    expect(await attachPictureToOpus(opus, cover)).toBe(true);

    expect(await readWithMusicMetadata(opus)).toBe(bytes);
  });

  it('keeps every existing tag, including ones readAudioTags does not model', async () => {
    // `-map_metadata 1` looks like it replaces the source metadata, and for a
    // re-encode it does. A stream copy carries the Opus comment header with the
    // stream, so the picture merges in instead. COPYRIGHT is the witness: the
    // app reads it but never writes it, so a rebuild-from-reader would drop it.
    const d = scratch();
    const tags = { ARTIST: 'TheArtist', ALBUM: 'TheAlbum', BPM: '128', COPYRIGHT: 'SomeLabel' };
    const opus = taggedOpus(d, tags);
    const before = await vorbisTags(opus);
    const cover = join(d, 'c.jpg');
    makeCover(cover, 400, 4);

    expect(await attachPictureToOpus(opus, cover)).toBe(true);

    expect(await vorbisTags(opus)).toEqual(before);
  });

  it('does not re-encode — the audio stream is untouched', async () => {
    const d = scratch();
    const opus = taggedOpus(d, {});
    const durBefore = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      opus,
    ])
      .toString()
      .trim();
    const cover = join(d, 'c.jpg');
    makeCover(cover, 400, 4);

    await attachPictureToOpus(opus, cover);

    const durAfter = execFileSync('ffprobe', [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'csv=p=0',
      opus,
    ])
      .toString()
      .trim();
    expect(durAfter).toBe(durBefore);
  });

  it('leaves no temp files behind', async () => {
    const d = scratch();
    const opus = taggedOpus(d, {});
    const cover = join(d, 'c.jpg');
    makeCover(cover, 400, 4);

    await attachPictureToOpus(opus, cover);

    const leaked = readdirSync(d).filter((n) => n.includes('nicotind-art'));
    expect(leaked).toEqual([]);
  });

  it('returns false and leaves the file intact when the cover is unreadable', async () => {
    // Art is an enhancement; the audio is already correct, so a failure here
    // must never cost the file.
    const d = scratch();
    const opus = taggedOpus(d, { ARTIST: 'A' });
    const before = await vorbisTags(opus);

    expect(await attachPictureToOpus(opus, join(d, 'does-not-exist.jpg'))).toBe(false);

    expect(await vorbisTags(opus)).toEqual(before);
    expect(readdirSync(d).filter((n) => n.includes('nicotind-art'))).toEqual([]);
  });

  it('a capped oversized cover still round-trips', async () => {
    // The two halves together: preparePicture brings it under the ceiling,
    // attachPictureToOpus puts it in, and the app can read it.
    const d = scratch();
    const opus = taggedOpus(d, {});
    const cover = join(d, 'big.jpg');
    makeCover(cover, 900, 2);

    const p = await preparePicture(cover, join(d, 'scratch.jpg'));
    expect(p).not.toBeNull();
    expect(await attachPictureToOpus(opus, p!.path)).toBe(true);

    expect(await readWithMusicMetadata(opus)).toBe(p!.bytes);
  });
});
