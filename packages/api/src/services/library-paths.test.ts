import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_DOWNLOADS_DIR,
  DEFAULT_UNSORTED_DIR,
  downloadsDirFor,
  isHiddenFile,
  isReservedPath,
  isReservedTopLevel,
  reservedDirsFor,
} from './library-paths.js';

describe('reservedDirsFor', () => {
  test('defaults to the shipped staging dirs', () => {
    expect([...reservedDirsFor()].sort()).toEqual([DEFAULT_DOWNLOADS_DIR, DEFAULT_UNSORTED_DIR]);
  });

  test('a configured non-dot override is reserved, so what we write to is what we skip', () => {
    // The #826 defect class: a hardcoded constant stops matching the moment an
    // operator overrides the config.
    const reserved = reservedDirsFor({ downloadsDir: 'staging' });
    expect(reserved.has('staging')).toBe(true);
  });

  test('an absolute downloadsDir is not a reserved name (it lives outside musicDir)', () => {
    expect(reservedDirsFor({ downloadsDir: '/mnt/fast/staging' }).has('/mnt/fast/staging')).toBe(
      false,
    );
  });
});

describe('isReservedTopLevel', () => {
  const reserved = reservedDirsFor();

  test('a dot-prefixed root directory is staging', () => {
    expect(isReservedTopLevel('.stversions', reserved)).toBe(true);
    expect(isReservedTopLevel('.downloads', reserved)).toBe(true);
  });

  test('an ordinary artist folder is not', () => {
    expect(isReservedTopLevel('The Rolling Stones', reserved)).toBe(false);
  });

  test('a reserved name without a dot still counts', () => {
    expect(isReservedTopLevel('staging', reservedDirsFor({ downloadsDir: 'staging' }))).toBe(true);
  });
});

describe('isReservedPath', () => {
  const reserved = reservedDirsFor();

  test('rejects a path under a reserved root', () => {
    expect(isReservedPath('.downloads/album/01.flac', reserved)).toBe(true);
  });

  test('an album whose title starts with dots is library content', () => {
    // Regression: both of these are real albums in the production library. An
    // unrestricted dot rule would have silently dropped them.
    expect(isReservedPath('DMX/...And Then There Was X/07 - Party Up.mp3', reserved)).toBe(false);
    expect(isReservedPath('Memphis La Blusera/...Etc/07 - Arrepentido.mp3', reserved)).toBe(false);
  });

  test('a dot-prefixed file is skipped at any depth', () => {
    expect(isReservedPath('Artist/Album/._01 - Track.flac', reserved)).toBe(true);
  });

  test('an ordinary track is library content', () => {
    expect(isReservedPath('Artist/Album/01 - Track.opus', reserved)).toBe(false);
  });
});

describe('isHiddenFile', () => {
  test('AppleDouble sidecars are hidden', () => {
    // extname('._Track.flac') === '.flac', so these match AUDIO_EXTENSIONS and
    // are scanned as audio without this rule.
    expect(isHiddenFile('._Track.flac')).toBe(true);
    expect(isHiddenFile('.DS_Store')).toBe(true);
  });

  test('an ordinary track file is not hidden', () => {
    expect(isHiddenFile('01 - Track.flac')).toBe(false);
  });
});

describe('downloadsDirFor', () => {
  test('a relative dir resolves under musicDir, keeping ingest on one filesystem', () => {
    expect(downloadsDirFor('/data/music')).toBe('/data/music/.downloads');
  });

  test('an absolute dir is used as given', () => {
    expect(downloadsDirFor('/data/music', { downloadsDir: '/mnt/fast/staging' })).toBe(
      '/mnt/fast/staging',
    );
  });
});
