import { describe, expect, it } from 'bun:test';
import { expandDir, isAbsolutePath, resolveSongPath, isUnderMusicDir } from './song-path.js';

// Direct coverage for the extracted triad (issue #416) — previously each copy
// was only exercised implicitly through its host route's tests.
describe('song-path triad', () => {
  it('expandDir expands ~ against HOME and leaves absolute dirs alone', () => {
    const home = process.env.HOME ?? '/root';
    expect(expandDir('~/music')).toBe(`${home}/music`);
    expect(expandDir('/srv/music')).toBe('/srv/music');
  });

  it('isAbsolutePath recognizes POSIX and normalized-Windows roots', () => {
    expect(isAbsolutePath('/a/b.flac')).toBe(true);
    expect(isAbsolutePath('C:/a/b.flac')).toBe(true);
    expect(isAbsolutePath('a/b.flac')).toBe(false);
  });

  it('resolveSongPath joins relative rows onto musicDir and normalizes backslashes', () => {
    expect(resolveSongPath('/music', 'Artist/Album/01.flac')).toBe('/music/Artist/Album/01.flac');
    expect(resolveSongPath('/music', 'Artist\\Album\\01.flac')).toBe('/music/Artist/Album/01.flac');
    expect(resolveSongPath('/music', '/elsewhere/01.flac')).toBe('/elsewhere/01.flac');
  });

  it('isUnderMusicDir rejects traversal escapes and the musicDir itself', () => {
    expect(isUnderMusicDir('/music', '/music/Artist/01.flac')).toBe(true);
    expect(isUnderMusicDir('/music', '/music')).toBe(false);
    expect(isUnderMusicDir('/music', '/etc/passwd')).toBe(false);
    expect(isUnderMusicDir('/music', resolveSongPath('/music', '../etc/passwd'))).toBe(false);
  });
});
