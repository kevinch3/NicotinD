import { describe, it, expect } from 'bun:test';
import { deriveAcquireAlbum } from './acquire-album.js';
import { albumIdFor } from './library-scanner.js';

describe('deriveAcquireAlbum', () => {
  it('derives artist/album/albumId from a canonical storage path', () => {
    const res = deriveAcquireAlbum('Lenny Kravitz/Circus');
    expect(res).toEqual({
      albumArtist: 'Lenny Kravitz',
      albumTitle: 'Circus',
      albumId: albumIdFor('Lenny Kravitz', 'Circus'),
    });
  });

  it('handles nested paths by using the last two segments', () => {
    const res = deriveAcquireAlbum('music/Artist/Some Album');
    expect(res?.albumArtist).toBe('Artist');
    expect(res?.albumTitle).toBe('Some Album');
    expect(res?.albumId).toBe(albumIdFor('Artist', 'Some Album'));
  });

  it('normalizes backslash separators (Windows paths)', () => {
    const res = deriveAcquireAlbum('Artist\\Album');
    expect(res?.albumArtist).toBe('Artist');
    expect(res?.albumTitle).toBe('Album');
  });

  it('returns null when the path lacks two segments or is empty', () => {
    expect(deriveAcquireAlbum('Singles')).toBeNull();
    expect(deriveAcquireAlbum('')).toBeNull();
    expect(deriveAcquireAlbum(null)).toBeNull();
  });
});
