import {
  resolveArtistRoute,
  resolveAlbumRoute,
  resolveGenreRoute,
  resolveArtistTarget,
} from './route-utils';

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

  describe('resolveArtistTarget', () => {
    const fail = () => Promise.reject(new Error('lookup should not be called'));

    it('uses the known id without a name lookup', async () => {
      expect(await resolveArtistTarget({ artistId: 'a1', artist: 'X' }, fail)).toEqual([
        '/library',
        'artists',
        'a1',
      ]);
    });

    it('resolves by name when no id is present and the artist exists locally', async () => {
      const lookup = (name: string) =>
        Promise.resolve(name === 'La Portuaria' ? 'art-lp' : null);
      expect(await resolveArtistTarget({ artist: 'La Portuaria' }, lookup)).toEqual([
        '/library',
        'artists',
        'art-lp',
      ]);
    });

    it('falls back to /library when the name does not resolve', async () => {
      expect(await resolveArtistTarget({ artist: 'Unknown Band' }, () => Promise.resolve(null))).toEqual(
        ['/library'],
      );
    });

    it('falls back to /library when there is neither id nor name', async () => {
      expect(await resolveArtistTarget({}, fail)).toEqual(['/library']);
    });
  });
});
