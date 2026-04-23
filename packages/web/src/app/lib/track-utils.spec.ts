import { toTrack, type BaseSong } from './track-utils';

describe('trackUtils', () => {
  describe('toTrack', () => {
    it('converts a full song object', () => {
      const song: BaseSong = {
        id: '1',
        title: 'Song Title',
        artist: 'Artist Name',
        artistId: 'ar-1',
        album: 'Album Name',
        coverArt: 'cover.jpg',
        duration: 180,
      };
      const track = toTrack(song);
      expect(track).toEqual({
        id: '1',
        title: 'Song Title',
        artist: 'Artist Name',
        artistId: 'ar-1',
        album: 'Album Name',
        coverArt: 'cover.jpg',
        duration: 180,
      });
    });

    it('propagates artistId to the track', () => {
      const song: BaseSong = { id: '5', title: 'T', artist: 'A', artistId: 'ar-99' };
      expect(toTrack(song).artistId).toBe('ar-99');
    });

    it('leaves artistId undefined when not provided', () => {
      const song: BaseSong = { id: '6', title: 'T', artist: 'A' };
      expect(toTrack(song).artistId).toBeUndefined();
    });

    it('uses fallback album if song album is missing', () => {
      const song: BaseSong = {
        id: '2',
        title: 'Song Title',
        artist: 'Artist Name',
      };
      const track = toTrack(song, 'Fallback Album');
      expect(track.album).toBe('Fallback Album');
    });

    it('prefers song album over fallback', () => {
      const song: BaseSong = {
        id: '3',
        title: 'Song Title',
        artist: 'Artist Name',
        album: 'Correct Album',
      };
      const track = toTrack(song, 'Wrong Album');
      expect(track.album).toBe('Correct Album');
    });

    it('handles missing optional fields', () => {
      const song: BaseSong = {
        id: '4',
        title: 'Song Title',
        artist: 'Artist Name',
      };
      const track = toTrack(song);
      expect(track.album).toBeUndefined();
      expect(track.coverArt).toBeUndefined();
      expect(track.duration).toBeUndefined();
    });

    it('propagates bitRate to the track', () => {
      const song: BaseSong = { id: '7', title: 'T', artist: 'A', bitRate: 320 };
      expect(toTrack(song).bitRate).toBe(320);
    });

    it('leaves bitRate undefined when not provided', () => {
      const song: BaseSong = { id: '8', title: 'T', artist: 'A' };
      expect(toTrack(song).bitRate).toBeUndefined();
    });
  });
});
