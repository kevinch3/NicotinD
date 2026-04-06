import { resolveArtistRoute } from './player.component';

describe('resolveArtistRoute', () => {
  it('returns /library/artists/:id when artistId is present', () => {
    expect(resolveArtistRoute('artist-123')).toEqual(['/library/artists', 'artist-123']);
  });

  it('returns /library when artistId is undefined', () => {
    expect(resolveArtistRoute(undefined)).toEqual(['/library']);
  });

  it('returns /library when artistId is empty string', () => {
    expect(resolveArtistRoute('')).toEqual(['/library']);
  });
});
