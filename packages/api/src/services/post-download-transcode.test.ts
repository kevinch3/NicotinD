/**
 * Tests for the post-download Opus transcode helper.
 *
 * `isLossless` is pure. `transcodeToLibraryFormat` spawns ffmpeg, so its tests generate
 * real audio and are skipped when ffmpeg is absent.
 *
 * **The `ci` job installs ffmpeg and opus-tools, so these run there (#1268).**
 *
 * They did not until then, and this comment has now been wrong twice about why.
 * It first claimed CI covered the path; corrected to "the `e2e` job is what
 * actually exercises them", which was also false — `e2e-shard` has ffmpeg but
 * runs Playwright specs only and never invokes the bun:test suite. So nothing
 * ran them at all: 55 gated blocks across 15 files skipped while `ci` printed
 * green. Read the job log for `(skip)` lines before believing any claim of this
 * shape, including this one.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { getMusicMetadata } from './music-metadata-loader.js';
import { tmpdir } from 'node:os';
import {
  isLossless,
  isLosslessFile,
  transcodeToLibraryFormat,
  encodeOutputVerdict,
} from './post-download-transcode.js';
import { ffmpegAvailable, transcodeOutputIsAcceptable } from './transcode.js';
import { readAudioTags, writeAudioTags, type AudioTags } from './audio-tags.js';
import { LIBRARY_FORMATS } from './library-format.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpRoot() {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'nicotind-transcode-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function makeAudio(path: string, codec: 'flac' | 'alac' | 'aac'): void {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'anullsrc=channel_layout=mono:sample_rate=22050',
      '-t',
      '0.3',
      '-c:a',
      codec,
      path,
    ],
    { stdio: 'ignore' },
  );
}

function makeFlac(path: string): void {
  makeAudio(path, 'flac');
}

/** A real multi-second FLAC with audible content (several frames to corrupt). */
function makeLongFlac(path: string): void {
  execFileSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:sample_rate=44100:duration=3',
      '-c:a',
      'flac',
      path,
    ],
    { stdio: 'ignore' },
  );
}

/** Flip a byte run at ~70% of the file — damages one audio frame, not the
 *  STREAMINFO header, mirroring the prod "invalid sync code" rips (#534). */
async function corruptOneFrame(path: string): Promise<void> {
  const buf = Buffer.from(await Bun.file(path).arrayBuffer());
  const start = Math.floor(buf.length * 0.7);
  for (let i = start; i < Math.min(start + 64, buf.length); i++) buf[i] = buf[i]! ^ 0xff;
  await Bun.write(path, buf);
}

describe('isLossless', () => {
  it('recognizes lossless suffixes with or without a leading dot', () => {
    for (const s of ['flac', '.flac', 'WAV', '.AIFF', 'alac', 'ape', 'wv']) {
      expect(isLossless(s)).toBe(true);
    }
  });

  it('rejects lossy and unknown suffixes', () => {
    for (const s of ['mp3', '.mp3', 'm4a', 'aac', 'opus', 'ogg', '', null, undefined]) {
      expect(isLossless(s)).toBe(false);
    }
  });
});

describe('isLosslessFile', () => {
  it('trusts unambiguous lossless extensions without opening the file', async () => {
    // Path doesn't exist — extension alone must decide.
    expect(await isLosslessFile('/nope/track.flac')).toBe(true);
    expect(await isLosslessFile('/nope/track.WAV')).toBe(true);
  });

  it('trusts unambiguous lossy extensions without opening the file', async () => {
    expect(await isLosslessFile('/nope/track.mp3')).toBe(false);
    expect(await isLosslessFile('/nope/track.opus')).toBe(false);
  });

  it.skipIf(!ffmpegAvailable())('detects ALAC hiding behind an .m4a extension', async () => {
    // ALAC ships in the same .m4a container as lossy AAC, so extension checks
    // miss it — this is how Apple Lossless rips slipped past the Opus
    // standardization and reached Firefox raw (NS_ERROR_DOM_MEDIA_METADATA_ERR).
    const root = tmpRoot();
    const alac = join(root, 'alac.m4a');
    makeAudio(alac, 'alac');
    expect(await isLosslessFile(alac)).toBe(true);
  });

  it.skipIf(!ffmpegAvailable())('leaves lossy AAC .m4a files alone', async () => {
    const root = tmpRoot();
    const aac = join(root, 'aac.m4a');
    makeAudio(aac, 'aac');
    expect(await isLosslessFile(aac)).toBe(false);
  });

  it('returns false for an unreadable .m4a instead of throwing', async () => {
    expect(await isLosslessFile('/nope/missing.m4a')).toBe(false);
  });
});

describe('transcodeToLibraryFormat', () => {
  it.skipIf(!ffmpegAvailable())('replaces a FLAC with an .opus file in place', async () => {
    const root = tmpRoot();
    const flac = join(root, '01 - Song.flac');
    makeFlac(flac);
    expect(existsSync(flac)).toBe(true);

    const out = await transcodeToLibraryFormat(flac, 128);

    expect(out).toBe(join(root, '01 - Song.opus'));
    expect(existsSync(out)).toBe(true);
    // Original lossless file is removed (storage reclaimed).
    expect(existsSync(flac)).toBe(false);
    // No leftover temp file.
    expect(existsSync(join(root, '01 - Song.nicotind-transcode.opus'))).toBe(false);
  });

  // #1305: the Opus output's duration is read in-process from its last Ogg
  // page. An encode whose output ffmpeg left without a complete final page
  // must still be refused, because the next statement deletes the original.
  it.skipIf(!ffmpegAvailable())(
    'refuses a truncated Opus output and keeps the original',
    async () => {
      const root = tmpRoot();
      const bin = join(root, 'bin');
      mkdirSync(bin);
      const realFfmpeg = execFileSync('which', ['ffmpeg'], { encoding: 'utf-8' }).trim();
      const realFfprobe = execFileSync('which', ['ffprobe'], { encoding: 'utf-8' }).trim();
      const wrapper = join(bin, 'ffmpeg');
      // Real ffmpeg, then cut 200 bytes off the transcode temp it wrote.
      writeFileSync(
        wrapper,
        `#!/bin/sh\n"${realFfmpeg}" "$@" || exit $?\nfor last; do :; done\n` +
          `case "$last" in *.nicotind-transcode.*) truncate -s -200 "$last";; esac\n`,
      );
      chmodSync(wrapper, 0o755);
      symlinkSync(realFfprobe, join(bin, 'ffprobe'));
      const flac = join(root, 'song.flac');
      makeLongFlac(flac);
      const prev = process.env.NICOTIND_FFMPEG_PATH;
      process.env.NICOTIND_FFMPEG_PATH = wrapper;
      try {
        await expect(transcodeToLibraryFormat(flac, 128)).rejects.toThrow(
          /Refusing to replace .*output duration could not be read/,
        );
      } finally {
        if (prev === undefined) delete process.env.NICOTIND_FFMPEG_PATH;
        else process.env.NICOTIND_FFMPEG_PATH = prev;
      }
      expect(existsSync(flac)).toBe(true);
      expect(existsSync(join(root, 'song.opus'))).toBe(false);
    },
  );

  it.skipIf(!ffmpegAvailable())('rejects and leaves the original on a bad input', async () => {
    const root = tmpRoot();
    const bogus = join(root, 'not-audio.flac');
    // A non-audio file ffmpeg can't decode.
    await Bun.write(bogus, 'this is not a flac');

    await expect(transcodeToLibraryFormat(bogus)).rejects.toThrow();
    // Original untouched, no temp/opus left behind.
    expect(existsSync(bogus)).toBe(true);
    expect(existsSync(join(root, 'not-audio.opus'))).toBe(false);
    expect(existsSync(join(root, 'not-audio.nicotind-transcode.opus'))).toBe(false);
  });

  // Issue #534: strict mode (`-err_detect explode -xerror`) rejected FLACs with
  // a single damaged frame although they decode fine leniently — the prod
  // Jason Mraz rip stayed un-standardized with 19 opaque "code 183" warnings.
  it.skipIf(!ffmpegAvailable())(
    'transcodes an imperfect-but-playable FLAC via the lenient retry',
    async () => {
      const root = tmpRoot();
      const flac = join(root, 'glitchy.flac');
      makeLongFlac(flac);
      await corruptOneFrame(flac);

      const out = await transcodeToLibraryFormat(flac, 128);

      expect(out).toBe(join(root, 'glitchy.opus'));
      expect(existsSync(out)).toBe(true);
      expect(existsSync(flac)).toBe(false);
    },
  );

  it.skipIf(!ffmpegAvailable())('carries the ffmpeg stderr detail in the error', async () => {
    const root = tmpRoot();
    const bogus = join(root, 'not-audio.flac');
    await Bun.write(bogus, 'this is not a flac');

    // The opaque "exited with code N" alone is what made #534 undiagnosable —
    // the message must carry an ffmpeg diagnostic, whichever line ends stderr.
    await expect(transcodeToLibraryFormat(bogus)).rejects.toThrow(/invalid data|no packets/i);
  });
});

/**
 * The denominator, asserted rather than assumed. Adding a field to `AudioTags`
 * breaks this object at COMPILE time until it is listed, so a new tag cannot
 * reach the library without someone deciding whether the transcode carries it.
 * A hand-kept list would silently go stale instead.
 *
 * At module scope because two suites share it: the mp3→Opus preservation block
 * below, and the per-format round-trip at the end of the file. One denominator,
 * not two that can drift apart.
 */
const ALL_AUDIO_TAG_FIELDS: Record<keyof AudioTags, true> = {
  artist: true,
  albumArtist: true,
  album: true,
  title: true,
  trackNumber: true,
  discNumber: true,
  year: true,
  genre: true,
  bpm: true,
  key: true,
  lyrics: true,
  energy: true,
  loudness: true,
  valence: true,
  danceability: true,
  acousticness: true,
  instrumental: true,
  mood: true,
  compilation: true,
  acoustIdId: true,
  mbRecordingId: true,
  mbReleaseId: true,
};

/**
 * Every field the library stores in a tag — all of them, on every source.
 *
 * `compilation` used to be excluded here, because node-id3 0.2.9 has no typed
 * TCMP field and #917 recorded it as unwritable on the ID3 path. That turned
 * out to be true of node-id3's *API* and false of its *behaviour*: it passes an
 * unrecognised four-character frame id straight through, so `{ TCMP: '1' }`
 * writes a real frame (#1256). The exclusion is gone rather than loosened —
 * while it stood, no test could tell "correctly absent" from "silently lost".
 */
const FULL_TAGS = {
  compilation: true,
  title: 'T',
  artist: 'A',
  albumArtist: 'AA',
  album: 'Al',
  trackNumber: 7,
  discNumber: 2,
  year: 1994,
  genre: 'Shoegaze',
  bpm: 128,
  key: 'Am',
  energy: 0.7,
  loudness: -9.5,
  valence: 0.4,
  danceability: 0.6,
  acousticness: 0.2,
  instrumental: 0.1,
  mood: 'happy' as const,
  lyrics: 'la la la',
  acoustIdId: '6d1b2f3c-0000-4000-8000-0000000000ac',
  mbRecordingId: '9e0a1b2c-0000-4000-8000-0000000000mb',
  mbReleaseId: '1f2e3d4c-0000-4000-8000-0000000000re',
};

describe('tag preservation through mp3 -> opus', () => {
  function makeMp3(path: string): void {
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t',
        '1',
        '-c:a',
        'libmp3lame',
        '-y',
        path,
      ],
      { stdio: 'ignore' },
    );
  }

  it('covers every AudioTags field', () => {
    // The gate on the gate: without this, extending `AudioTags` and forgetting
    // to extend `FULL_TAGS` leaves the new field untested while the suite stays
    // green, which is exactly how bpm/key/lyrics were lost unnoticed.
    expect(Object.keys(FULL_TAGS).sort()).toEqual(Object.keys(ALL_AUDIO_TAG_FIELDS).sort());
  });

  it.skipIf(!ffmpegAvailable())('loses nothing — not bpm, key or lyrics', async () => {
    // Measured, not assumed: ffmpeg's `-map_metadata 0` carries every ID3 TXXX
    // user-text frame into Vorbis comments on its own, but silently drops the
    // three NATIVE frames — TBPM, TKEY and USLT. A dropped BPM means the track
    // is re-analysed forever, since the analyzers prefer the file's own tag.
    const root = tmpRoot();
    const src = join(root, 'song.mp3');
    makeMp3(src);
    expect(await writeAudioTags(src, FULL_TAGS)).toBe(true);
    const before = await readAudioTags(src);

    const out = await transcodeToLibraryFormat(src, 96);
    const after = await readAudioTags(out);

    const lost = (Object.keys(FULL_TAGS) as Array<keyof typeof FULL_TAGS>).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    expect(lost).toEqual([]);

    // Named explicitly too: these are the ones that regress, so a future
    // failure should say which rather than only that the set shrank.
    expect(after.bpm).toBe(128);
    expect(after.key).toBe('Am');
    expect(after.lyrics).toBe('la la la');
    expect(after.acoustIdId).toBe(FULL_TAGS.acoustIdId);
    expect(after.mbRecordingId).toBe(FULL_TAGS.mbRecordingId);
    expect(after.mbReleaseId).toBe(FULL_TAGS.mbReleaseId);
  });

  it.skipIf(!ffmpegAvailable())('writes the ids under canonical keys, once each', async () => {
    // `lost` above would pass with the value stored twice — under the spaced
    // key ffmpeg derives from the TXXX description AND the canonical one. A
    // duplicated comment is carried forward by every later pass, so assert the
    // file is clean, not just readable.
    const root = tmpRoot();
    const src = join(root, 'ids.mp3');
    makeMp3(src);
    await writeAudioTags(src, FULL_TAGS);

    const out = await transcodeToLibraryFormat(src, 96);

    const mm = await getMusicMetadata();
    const comments = ((await mm!.parseFile(out)).native?.vorbis ?? [])
      .map((t) => t.id)
      .filter((id) => /ACOUSTID|MUSICBRAINZ/i.test(id))
      .sort();
    expect(comments).toEqual(['ACOUSTID_ID', 'MUSICBRAINZ_ALBUMID', 'MUSICBRAINZ_TRACKID']);
  });

  it.skipIf(!ffmpegAvailable())(
    'writes the unmodelled MusicBrainz TXXX frames under canonical names too (#1250)',
    async () => {
      // ffmpeg names each TXXX's Vorbis comment after its description, spaces
      // intact. The three modelled ids were fixed in #1230; these are the rest,
      // measured on prod after the conversion.
      const root = tmpRoot();
      const src = join(root, 'unmodelled.mp3');
      execFileSync(
        'ffmpeg',
        [
          ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
          ...['-i', 'anullsrc=channel_layout=stereo:sample_rate=44100', '-t', '1'],
          ...['-c:a', 'libmp3lame', '-id3v2_version', '3'],
          ...['-metadata', 'album_artist=Same'],
          ...['-metadata', 'ALBUM ARTIST=Same'],
          ...['-metadata', 'MusicBrainz Artist Id=artist-1'],
          ...['-metadata', 'MusicBrainz Release Group Id=rg-1'],
          ...['-metadata', 'MusicBrainz Album Type=album'],
          ...['-y', src],
        ],
        { stdio: 'ignore' },
      );

      const out = await transcodeToLibraryFormat(src, 96);

      const mm = await getMusicMetadata();
      const keys = Object.fromEntries(
        ((await mm!.parseFile(out)).native?.vorbis ?? []).map((t) => [t.id.toUpperCase(), t.value]),
      );
      expect(keys.MUSICBRAINZ_ARTISTID).toBe('artist-1');
      expect(keys.MUSICBRAINZ_RELEASEGROUPID).toBe('rg-1');
      expect(keys.RELEASETYPE).toBe('album');
      expect(keys.ALBUMARTIST).toBe('Same');
      expect(Object.keys(keys).filter((k) => k.includes(' '))).toEqual([]);
    },
  );

  it.skipIf(!ffmpegAvailable())('still converts a source carrying no tags at all', async () => {
    const root = tmpRoot();
    const src = join(root, 'bare.mp3');
    makeMp3(src);
    const out = await transcodeToLibraryFormat(src, 96);
    expect(existsSync(out)).toBe(true);
    expect(out.endsWith('.opus')).toBe(true);
  });

  it.skipIf(!ffmpegAvailable())('loses nothing from a FLAC source either', async () => {
    // The lossless path is the bulk of the conversion, and it is Vorbis to
    // Vorbis rather than ID3 to Vorbis — a different mapping, so the mp3 case
    // does not cover it. `compilation` is only testable here: node-id3 has no
    // TCMP frame, so the mp3 writer cannot emit it at all (#917). It matters
    // because the organizer re-remuxes any file whose `compilation` reads
    // false, so losing it puts every compilation track in a rewrite loop.
    const root = tmpRoot();
    const src = join(root, 'various.flac');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t',
        '1',
        '-c:a',
        'flac',
        '-y',
        src,
      ],
      { stdio: 'ignore' },
    );
    const full = { ...FULL_TAGS, compilation: true };
    expect(await writeAudioTags(src, full)).toBe(true);
    const before = await readAudioTags(src);
    expect(before.compilation).toBe(true);

    const out = await transcodeToLibraryFormat(src, 96);
    const after = await readAudioTags(out);

    const lost = (Object.keys(full) as Array<keyof typeof full>).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    expect(lost).toEqual([]);
    expect(after.compilation).toBe(true);
  });
});

/**
 * The same round-trip, for **every** format the library can be standardized on.
 *
 * Table-driven off `LIBRARY_FORMATS` rather than a hand-written list, so a
 * format cannot join the registry without this running against it — the
 * denominator discipline that `ALL_AUDIO_TAG_FIELDS` already applies to the
 * fields, applied to the formats too.
 *
 * A FLAC source on purpose: it is the one container whose writer emits every
 * field including `compilation` (node-id3 has no TCMP frame, #917), so each
 * target is measured against a complete tag set rather than a partial one.
 *
 * This is the test #1230's lesson asks for — "a preservation test that does not
 * assert its own denominator hides exactly this" — and it is what would have
 * caught #1225 (bpm/key/lyrics), #1230 (TXXX misnaming), #1249 (UFID) and #1177
 * (the tmpo atom) at the moment each was introduced rather than months later
 * against quarantined originals.
 */
describe.skipIf(!ffmpegAvailable())('every library format carries every tag (#1256)', () => {
  const FULL_WITH_COMPILATION = { ...FULL_TAGS, compilation: true };

  function makeTaggedFlac(root: string): string {
    const src = join(root, 'source.flac');
    makeFlac(src);
    return src;
  }

  it('covers every registered format', () => {
    // The gate on the gate: if a format joins the registry, it appears here
    // automatically. A hand-kept list would go stale silently, which is the
    // failure this whole file exists to prevent.
    expect(Object.keys(LIBRARY_FORMATS).length).toBeGreaterThan(0);
  });

  for (const [id, strategy] of Object.entries(LIBRARY_FORMATS)) {
    it(`carries all ${Object.keys(ALL_AUDIO_TAG_FIELDS).length} AudioTags fields into ${id}`, async () => {
      const root = tmpRoot();
      const src = makeTaggedFlac(root);
      expect(await writeAudioTags(src, FULL_WITH_COMPILATION)).toBe(true);
      const before = await readAudioTags(src);
      // The source must actually carry what we are about to check for, or a
      // "nothing was lost" result is vacuous on both sides.
      expect(before.compilation).toBe(true);
      expect(before.bpm).toBe(128);

      const out = await transcodeToLibraryFormat(
        src,
        128,
        undefined,
        id as keyof typeof LIBRARY_FORMATS,
      );
      expect(out.endsWith(`.${strategy.ext}`)).toBe(true);

      const after = await readAudioTags(out);
      const lost = (
        Object.keys(FULL_WITH_COMPILATION) as Array<keyof typeof FULL_WITH_COMPILATION>
      ).filter((k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]));
      expect(lost).toEqual([]);
    });
  }
});

describe('encodeOutputVerdict — fails closed, because the caller then deletes the source', () => {
  it('accepts an output at least as long as the source', () => {
    expect(encodeOutputVerdict(180, 180).ok).toBe(true);
  });

  it('accepts a shortfall inside the tolerance', () => {
    expect(encodeOutputVerdict(180, 179.5).ok).toBe(true);
  });

  it('rejects a truncated output', () => {
    const v = encodeOutputVerdict(180, 12);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('shorter than source');
  });

  // The two that used to pass. `transcodeOutputIsAcceptable` returns true when
  // either duration is null — correct for the streaming CACHE, where a bad file
  // is regenerated, and wrong here, where the next statement is an unlink.
  it('REJECTS an unreadable source duration', () => {
    const v = encodeOutputVerdict(null, 180);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('source duration');
  });

  it('REJECTS an unreadable output duration', () => {
    const v = encodeOutputVerdict(180, null);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toContain('output duration');
  });

  it('rejects a zero or non-finite output duration', () => {
    expect(encodeOutputVerdict(180, 0).ok).toBe(false);
    expect(encodeOutputVerdict(180, Number.NaN).ok).toBe(false);
    expect(encodeOutputVerdict(180, Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it('names which check failed, not just that one did', () => {
    // A run over thousands of files has to distinguish "came out short" from
    // "could not be probed" — they are different operator problems.
    const truncated = encodeOutputVerdict(180, 12);
    const unprobeable = encodeOutputVerdict(180, null);
    expect(truncated.ok === false && unprobeable.ok === false).toBe(true);
    expect(truncated.ok === false && truncated.reason).not.toBe(
      unprobeable.ok === false ? unprobeable.reason : '',
    );
  });

  it('keeps the streaming path lenient — the two policies must differ', () => {
    // Same inputs, opposite verdicts, on purpose. If these ever agree, one of
    // the two callers has the wrong policy for its stakes.
    expect(transcodeOutputIsAcceptable(null, 180)).toBe(true);
    expect(encodeOutputVerdict(null, 180).ok).toBe(false);
  });
});

describe.skipIf(!ffmpegAvailable())('cover art survives the transcode', () => {
  function makeFlacWithCover(
    dir: string,
    coverPx: number,
    quality = 4,
    // `geq=random` is worst-case incompressible, which is wrong for an
    // oversized-cover fixture: a real photo shrinks under re-compression and
    // noise does not. `mandelbrot` has real detail and still compresses.
    source = `nullsrc=s=${coverPx}x${coverPx},geq=random(1)*255:128:128`,
  ): { flac: string; coverBytes: number } {
    const cover = join(dir, 'art.jpg');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        source,
        '-frames:v',
        '1',
        '-q:v',
        String(quality),
        '-y',
        cover,
      ],
      { stdio: 'ignore' },
    );
    const bare = join(dir, 'bare.flac');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t',
        '1',
        '-c:a',
        'flac',
        '-y',
        bare,
      ],
      { stdio: 'ignore' },
    );
    const flac = join(dir, 'song.flac');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        bare,
        '-i',
        cover,
        '-map',
        '0:a',
        '-map',
        '1:v',
        '-c',
        'copy',
        '-disposition:v',
        'attached_pic',
        '-metadata',
        'ARTIST=TheArtist',
        '-y',
        flac,
      ],
      { stdio: 'ignore' },
    );
    return { flac, coverBytes: statSync(cover).size };
  }

  it('carries the embedded cover from a FLAC into the Opus', async () => {
    // The whole point of #1226: `-vn` drops the attached picture and nothing
    // downstream could recover it. 0 of 7,774 already-converted files have art.
    const root = tmpRoot();
    const { flac, coverBytes } = makeFlacWithCover(root, 500);

    const out = await transcodeToLibraryFormat(flac, 96);

    const mm = await getMusicMetadata();
    const pic = (await mm!.parseFile(out)).common.picture?.[0];
    expect(pic?.data.length).toBe(coverBytes);
  });

  it('keeps the tags while carrying the cover', async () => {
    const root = tmpRoot();
    const { flac } = makeFlacWithCover(root, 400);

    const out = await transcodeToLibraryFormat(flac, 96);

    expect((await readAudioTags(out)).artist).toBe('TheArtist');
  });

  it('writes canonical tags in the encode, over the source values, and keeps the cover (#1305)', async () => {
    const root = tmpRoot();
    const { flac, coverBytes } = makeFlacWithCover(root, 400);

    const out = await transcodeToLibraryFormat(flac, 96, undefined, undefined, {
      artist: 'Settled Artist',
      albumArtist: 'Settled Album Artist',
      album: 'Settled Album',
      title: 'Settled Title',
      trackNumber: 7,
      year: 1999,
    });

    expect(await readAudioTags(out)).toMatchObject({
      artist: 'Settled Artist',
      albumArtist: 'Settled Album Artist',
      album: 'Settled Album',
      title: 'Settled Title',
      trackNumber: 7,
      year: 1999,
    });
    const mm = await getMusicMetadata();
    expect((await mm!.parseFile(out)).common.picture?.[0]?.data.length).toBe(coverBytes);
  });

  it('carries a cover that is OVER the embed cap, by re-compressing it', async () => {
    // The case nothing covered, and it cost 10% of the library's art. The
    // scratch paths had no image extension, so `ffmpeg -i in -q:v N out` could
    // not pick an output muxer; every re-compress failed and every oversized
    // cover was silently dropped. Small covers kept working, which is why the
    // earlier tests all passed.
    const root = tmpRoot();
    const { flac, coverBytes } = makeFlacWithCover(root, 1800, 2, 'mandelbrot=s=1800x1800');
    expect(coverBytes).toBeGreaterThan(512 * 1024); // ~597 KB, over the cap

    const out = await transcodeToLibraryFormat(flac, 96);

    const mm = await getMusicMetadata();
    const pic = (await mm!.parseFile(out)).common.picture?.[0];
    expect(pic).toBeDefined();
    // Re-compressed to fit, not carried verbatim and not dropped.
    expect(pic!.data.length).toBeLessThanOrEqual(512 * 1024);
    expect(pic!.data.length).toBeGreaterThan(0);
  });

  it('converts a source with no cover exactly as before', async () => {
    const root = tmpRoot();
    const bare = join(root, 'plain.flac');
    execFileSync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=channel_layout=stereo:sample_rate=44100',
        '-t',
        '1',
        '-c:a',
        'flac',
        '-y',
        bare,
      ],
      { stdio: 'ignore' },
    );

    const out = await transcodeToLibraryFormat(bare, 96);

    expect(existsSync(out)).toBe(true);
    const mm = await getMusicMetadata();
    expect((await mm!.parseFile(out)).common.picture?.length ?? 0).toBe(0);
  });

  it('leaves no cover temp files beside the output', async () => {
    const root = tmpRoot();
    const { flac } = makeFlacWithCover(root, 400);

    await transcodeToLibraryFormat(flac, 96);

    const leaked = readdirSync(root).filter(
      (n) => n.includes('cover-src') || n.includes('cover-fit'),
    );
    expect(leaked).toEqual([]);
  });
});
