import { resolveArtistRoute, resolveAlbumRoute, resolveGenreRoute } from './route-utils';

describe('route-utils', () => {
  describe('resolveArtistRoute', () => {
    it('returns artist route for generic id', () => {
      expect(resolveArtistRoute('artist-123')).toEqual(['/library', 'artists', 'artist-123']);
    });
    it('returns library for undefined', () => {
      expect(resolveArtistRoute(undefined)).toEqual(['/library']);
    });
    it('returns library for empty string', () => {
      expect(resolveArtistRoute('')).toEqual(['/library']);
    });
  });

  describe('resolveAlbumRoute', () => {
    it('returns album route for generic id', () => {
      expect(resolveAlbumRoute('album-123')).toEqual(['/library', 'albums', 'album-123']);
    });
    it('returns library for undefined', () => {
      expect(resolveAlbumRoute(undefined)).toEqual(['/library']);
    });
  });

  describe('resolveGenreRoute', () => {
    it('returns genre route for generic slug', () => {
      expect(resolveGenreRoute('rock')).toEqual(['/library', 'genres', 'rock']);
    });
    it('returns library for undefined', () => {
      expect(resolveGenreRoute(undefined)).toEqual(['/library']);
    });
  });
});
