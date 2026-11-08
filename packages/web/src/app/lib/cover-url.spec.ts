import { describe, expect, it } from 'vitest';
import { albumCover, artistCover, coverUrl, songCover, withMediaToken } from './cover-url';

describe('withMediaToken', () => {
  const remote = `/api/cover/remote?u=${encodeURIComponent('https://images.lidarr.audio/c.jpg')}`;

  it('appends the token to a proxied catalog cover', () => {
    expect(withMediaToken(remote, 'mk')).toBe(`${remote}&token=mk`);
  });

  it('uses ? when the cover URL has no query yet', () => {
    expect(withMediaToken('/api/cover/abc', 'mk')).toBe('/api/cover/abc?token=mk');
  });

  it('leaves a URL that already carries a token alone', () => {
    expect(withMediaToken('/api/cover/abc?size=300&token=old', 'mk')).toBe(
      '/api/cover/abc?size=300&token=old',
    );
  });

  it('never sends the token to a third-party URL', () => {
    expect(withMediaToken('https://i.scdn.co/image/x', 'mk')).toBe('https://i.scdn.co/image/x');
  });

  it('passes through a missing URL or a signed-out session', () => {
    expect(withMediaToken(undefined, 'mk')).toBeUndefined();
    expect(withMediaToken(remote, null)).toBe(remote);
  });
});

describe('coverUrl (#1666)', () => {
  const ref = { coverArt: 'al1', coverRev: 0, kind: 'album' as const, id: 'al1' };

  it('leaves v off at rev 0, so the URLs browsers already cached stay valid', () => {
    expect(coverUrl(ref, 300, 'mk')).toBe('/api/cover/al1?size=300&token=mk');
  });

  it('carries the rev, so the URL changes with the bytes', () => {
    expect(coverUrl({ ...ref, coverRev: 4 }, 300, 'mk')).toBe(
      '/api/cover/al1?size=300&v=4&token=mk',
    );
    expect(coverUrl({ ...ref, coverRev: 5 }, 300, 'mk')).not.toBe(
      coverUrl({ ...ref, coverRev: 4 }, 300, 'mk'),
    );
  });

  it('spells a signed-out token as empty, like before', () => {
    expect(coverUrl(ref, 96, null)).toBe('/api/cover/al1?size=96&token=');
  });
});

describe('cover refs (#1666)', () => {
  it('an artist owns its own rev', () => {
    expect(artistCover({ id: 'ar1', coverArt: 'ar1', coverRev: 2 })).toEqual({
      coverArt: 'ar1',
      coverRev: 2,
      kind: 'artist',
      id: 'ar1',
    });
  });

  it('an album owns its own rev; a DTO without one reads as 0', () => {
    expect(albumCover({ id: 'al1', coverArt: 'al1' })).toEqual({
      coverArt: 'al1',
      coverRev: 0,
      kind: 'album',
      id: 'al1',
    });
  });

  // The overlay key must be the entity that owns the rev: a song with embedded
  // art names itself as `coverArt`, but the rev that moves is its album's.
  it("a song's rev is owned by its album, even when its cover id is its own", () => {
    expect(songCover({ coverArt: 'song-9', coverRev: 3, albumId: 'al1' })).toEqual({
      coverArt: 'song-9',
      coverRev: 3,
      kind: 'album',
      id: 'al1',
    });
    expect(songCover({ coverArt: 'al1' })?.id).toBe('al1');
  });

  it('no cover id, no ref', () => {
    expect(artistCover({ id: 'ar1', coverArt: null })).toBeNull();
    expect(albumCover({ id: 'al1' })).toBeNull();
    expect(songCover({ coverArt: undefined, albumId: 'al1' })).toBeNull();
  });
});
