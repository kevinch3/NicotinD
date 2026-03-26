import { describe, expect, it } from 'bun:test';
import { toTrack, type BaseSong } from './trackUtils';

describe('trackUtils', () => {
  describe('toTrack', () => {
    it('converts a full song object', () => {
      const song: BaseSong = {
        id: '1',
        title: 'Song Title',
        artist: 'Artist Name',
        album: 'Album Name',
        coverArt: 'cover.jpg',
        duration: 180,
      };
      const track = toTrack(song);
      expect(track).toEqual({
        id: '1',
        title: 'Song Title',
        artist: 'Artist Name',
        album: 'Album Name',
        coverArt: 'cover.jpg',
        duration: 180,
      });
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
  });
});
