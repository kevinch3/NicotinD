/**
 * Tests for the post-download Opus transcode helper.
 *
 * `isLossless` is pure. `transcodeToOpus` spawns ffmpeg, so its tests generate
 * real audio and are skipped when ffmpeg is absent.
 *
 * Note the `ci` gate job does NOT have ffmpeg — these skip there, and the `e2e`
 * job is what actually exercises them. An earlier version of this comment
 * claimed CI covered the path; the job log says otherwise.
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLossless, isLosslessFile, transcodeToOpus } from './post-download-transcode.js';
import { ffmpegAvailable } from './transcode.js';
import { readAudioTags, writeAudioTags } from './audio-tags.js';

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

describe('transcodeToOpus', () => {
  it.skipIf(!ffmpegAvailable())('replaces a FLAC with an .opus file in place', async () => {
    const root = tmpRoot();
    const flac = join(root, '01 - Song.flac');
    makeFlac(flac);
    expect(existsSync(flac)).toBe(true);

    const out = await transcodeToOpus(flac, 128);

    expect(out).toBe(join(root, '01 - Song.opus'));
    expect(existsSync(out)).toBe(true);
    // Original lossless file is removed (storage reclaimed).
    expect(existsSync(flac)).toBe(false);
    // No leftover temp file.
    expect(existsSync(join(root, '01 - Song.nicotind-transcode.opus'))).toBe(false);
  });

  it.skipIf(!ffmpegAvailable())('rejects and leaves the original on a bad input', async () => {
    const root = tmpRoot();
    const bogus = join(root, 'not-audio.flac');
    // A non-audio file ffmpeg can't decode.
    await Bun.write(bogus, 'this is not a flac');

    await expect(transcodeToOpus(bogus)).rejects.toThrow();
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

      const out = await transcodeToOpus(flac, 128);

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
    await expect(transcodeToOpus(bogus)).rejects.toThrow(/invalid data|no packets/i);
  });
});

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

  // Every field the library stores in a tag. The point of listing them all is
  // that a future field is caught here rather than discovered missing later.
  const FULL_TAGS = {
    title: 'T',
    artist: 'A',
    album: 'Al',
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
  };

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

    const out = await transcodeToOpus(src, 96);
    const after = await readAudioTags(out);

    const lost = (Object.keys(FULL_TAGS) as Array<keyof typeof FULL_TAGS>).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    expect(lost).toEqual([]);

    // Named explicitly too: these three are the ones that regress, so a future
    // failure should say which rather than only that the set shrank.
    expect(after.bpm).toBe(128);
    expect(after.key).toBe('Am');
    expect(after.lyrics).toBe('la la la');
  });

  it.skipIf(!ffmpegAvailable())('still converts a source carrying no tags at all', async () => {
    const root = tmpRoot();
    const src = join(root, 'bare.mp3');
    makeMp3(src);
    const out = await transcodeToOpus(src, 96);
    expect(existsSync(out)).toBe(true);
    expect(out.endsWith('.opus')).toBe(true);
  });
});
