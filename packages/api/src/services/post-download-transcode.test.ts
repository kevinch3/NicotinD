/**
 * Tests for the post-download Opus transcode helper.
 *
 * `isLossless` is pure. `transcodeToOpus` spawns ffmpeg, so its test generates a
 * real FLAC via ffmpeg and is skipped when ffmpeg is absent (GitHub ubuntu
 * runners ship it, so CI still covers the path).
 */
import { describe, expect, it, afterEach } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLossless, isLosslessFile, transcodeToOpus } from './post-download-transcode.js';
import { ffmpegAvailable } from './transcode.js';

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
});
