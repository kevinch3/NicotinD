import { vi } from 'vitest';
import { toTrack, offlineTrackAction, addToPlaylistAction, type BaseSong } from './track-utils';
import type { PreserveService } from '../services/preserve.service';
import type { PlaylistService } from '../services/playlist.service';
import type { Track } from '../services/player.service';

function fakePreserve(state: {
  preserved?: boolean;
  inProgress?: boolean;
}): PreserveService & { preserve: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } {
  return {
    isPreserved: () => state.preserved ?? false,
    isPreserving: () => state.inProgress ?? false,
    preserve: vi.fn(),
    remove: vi.fn(),
  } as unknown as PreserveService & {
    preserve: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };
}

const TRACK: Track = { id: 't1', title: 'T', artist: 'A' };

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

  describe('offlineTrackAction', () => {
    it('offers "Save offline" and preserves when not yet saved', () => {
      const preserve = fakePreserve({ preserved: false });
      const action = offlineTrackAction(preserve, TRACK);
      expect(action.label).toBe('Save offline');
      expect(action.destructive).toBe(false);
      action.action();
      expect(preserve.preserve).toHaveBeenCalledWith(TRACK);
      expect(preserve.remove).not.toHaveBeenCalled();
    });

    it('offers "Remove download" and removes when already saved', () => {
      const preserve = fakePreserve({ preserved: true });
      const action = offlineTrackAction(preserve, TRACK);
      expect(action.label).toBe('Remove download');
      expect(action.destructive).toBe(true);
      action.action();
      expect(preserve.remove).toHaveBeenCalledWith('t1');
      expect(preserve.preserve).not.toHaveBeenCalled();
    });

    it('is a no-op while a save is in progress', () => {
      const preserve = fakePreserve({ inProgress: true });
      const action = offlineTrackAction(preserve, TRACK);
      expect(action.label).toBe('Saving…');
      action.action();
      expect(preserve.preserve).not.toHaveBeenCalled();
      expect(preserve.remove).not.toHaveBeenCalled();
    });
  });

  describe('addToPlaylistAction', () => {
    it('opens the picker for the single song id', () => {
      const openPicker = vi.fn();
      const playlists = { openPicker } as unknown as PlaylistService;
      const action = addToPlaylistAction(playlists, 'song-42');
      expect(action.label).toBe('Add to playlist');
      action.action();
      expect(openPicker).toHaveBeenCalledWith(['song-42']);
    });
  });
});
