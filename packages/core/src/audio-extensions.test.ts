import { describe, expect, test } from 'bun:test';
import { AUDIO_EXTENSIONS, ID3_EXTS, VORBIS_EXTS, isAudioFile } from './audio-extensions.js';

describe('AUDIO_EXTENSIONS', () => {
  test('is the union of every container the library has ever indexed', () => {
    // The bug this exists to prevent (#845): library-disk-audit walked disk with
    // a set lacking .wma while the scanner indexed with one that had it, so every
    // .wma row reported as `missing_file` forever — a finding whose obvious
    // remediation is deleting a row for a file that is present.
    for (const ext of [
      '.mp3',
      '.flac',
      '.m4a',
      '.aac',
      '.ogg',
      '.opus',
      '.wav',
      '.wma',
      '.alac',
      '.aiff',
      '.webm',
    ]) {
      expect({ ext, member: AUDIO_EXTENSIONS.has(ext) }).toEqual({ ext, member: true });
    }
  });

  test('excludes non-audio', () => {
    for (const ext of ['.jpg', '.cue', '.nfo', '.txt', '.m3u']) {
      expect({ ext, member: AUDIO_EXTENSIONS.has(ext) }).toEqual({ ext, member: false });
    }
  });
});

describe('isAudioFile', () => {
  test('matches on the extension regardless of case', () => {
    expect(isAudioFile('Track.FLAC')).toBe(true);
    expect(isAudioFile('Track.Wma')).toBe(true);
  });

  test('handles a path, not just a basename', () => {
    expect(isAudioFile('/data/music/Artist/Album/01 - Track.opus')).toBe(true);
  });

  test('a dotfile with no real extension is not audio', () => {
    expect(isAudioFile('.flac')).toBe(false);
  });

  test('rejects non-audio', () => {
    expect(isAudioFile('cover.jpg')).toBe(false);
    expect(isAudioFile('no-extension')).toBe(false);
  });
});

describe('tag-format subsets', () => {
  // These are legitimately narrower — they describe which tag container a
  // writer understands, not what counts as library content. Named for that.
  test('are subsets of the canonical set', () => {
    for (const ext of [...ID3_EXTS, ...VORBIS_EXTS]) {
      expect({ ext, member: AUDIO_EXTENSIONS.has(ext) }).toEqual({ ext, member: true });
    }
  });

  test('cover the formats their writers support', () => {
    expect([...ID3_EXTS].sort()).toEqual(['.mp3']);
    expect([...VORBIS_EXTS].sort()).toEqual(['.flac', '.ogg', '.opus']);
  });
});
