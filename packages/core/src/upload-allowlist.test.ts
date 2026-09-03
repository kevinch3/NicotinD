import { describe, expect, it } from 'bun:test';
import { isUploadableName } from './upload-allowlist.js';
import { extensionOf } from './audio-extensions.js';

describe('isUploadableName', () => {
  it('accepts every audio container the library indexes', () => {
    for (const name of ['a/01.flac', 'a/02.mp3', 'a/03.m4a', 'a/04.opus', 'a/05.wma']) {
      expect(isUploadableName(name)).toBe(true);
    }
  });

  it('accepts album art under the conventional names only', () => {
    expect(isUploadableName('Album/cover.jpg')).toBe(true);
    expect(isUploadableName('Album/folder.png')).toBe(true);
    expect(isUploadableName('Album/FRONT.JPEG')).toBe(true);
    // A random photo is not album art — uploading a phone dump of holiday
    // pictures because they sit next to the music helps nobody.
    expect(isUploadableName('Album/IMG_20240101.jpg')).toBe(false);
  });

  it('rejects the clutter a music folder accumulates', () => {
    for (const name of ['a/notes.nfo', 'a/list.m3u', 'a/scan.pdf', 'a/readme.txt']) {
      expect(isUploadableName(name)).toBe(false);
    }
  });

  // macOS AppleDouble sidecars are the trap: `extname('._Track.flac')` is
  // '.flac', so an extension-only test uploads a 4 KB resource fork as if it
  // were the song.
  it('rejects dot-prefixed names, AppleDouble sidecars included', () => {
    expect(isUploadableName('Album/._Track.flac')).toBe(false);
    expect(isUploadableName('Album/.DS_Store')).toBe(false);
  });

  it('judges the basename, not the path', () => {
    expect(isUploadableName('.hidden/01.flac')).toBe(true);
    expect(isUploadableName('01.flac')).toBe(true);
  });

  it('is case-insensitive about the extension', () => {
    expect(isUploadableName('a/01.FLAC')).toBe(true);
  });
});

// `extensionOf` replaced node's `extname` so the module can reach the browser.
// These pin the two behaviours that swap would quietly break.
describe('extensionOf parity with node extname', () => {
  it('reads the basename, so a dot in a directory is not an extension', () => {
    expect(extensionOf('/music/My.Album/track')).toBe('');
    expect(extensionOf('My.Album/01.flac')).toBe('.flac');
  });

  it('treats a leading dot as no extension, which is what excludes dotfiles', () => {
    expect(extensionOf('.flac')).toBe('');
    expect(extensionOf('._Track.flac')).toBe('.flac');
  });

  it('lowercases, so a shouty extension still matches', () => {
    expect(extensionOf('TRACK.FLAC')).toBe('.flac');
  });

  it('handles windows separators, which a zip entry can carry', () => {
    expect(extensionOf('Album\\CD1\\01.flac')).toBe('.flac');
  });
});
