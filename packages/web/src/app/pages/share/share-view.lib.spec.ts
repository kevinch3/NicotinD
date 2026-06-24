import { describe, it, expect } from 'vitest';
import { mapSharedAlbum, mapSharedPlaylist } from './share-view.lib';

describe('mapSharedAlbum', () => {
  it('maps name, artist and the `song` array', () => {
    const view = mapSharedAlbum({
      name: 'Discovery',
      artist: 'Daft Punk',
      coverArt: 'alb1',
      song: [{ id: 's1', title: 'One More Time', artist: 'Daft Punk', track: 1, duration: 320 }],
    });
    expect(view.name).toBe('Discovery');
    expect(view.subtitle).toBe('Daft Punk');
    expect(view.coverId).toBe('alb1');
    expect(view.ogType).toBe('music.album');
    expect(view.tracks).toHaveLength(1);
    expect(view.tracks[0].title).toBe('One More Time');
  });
});

describe('mapSharedPlaylist', () => {
  it('reads `songs` (not `entry`) so tracks are not dropped', () => {
    const view = mapSharedPlaylist({
      name: 'Road Trip',
      coverArt: null,
      songs: [
        { id: 's1', title: 'A', artist: 'X', coverArt: 'covA' },
        { id: 's2', title: 'B', artist: 'Y', coverArt: 'covB' },
      ],
    });
    expect(view.tracks).toHaveLength(2);
    expect(view.name).toBe('Road Trip');
    expect(view.subtitle).toBe('2 tracks');
    expect(view.ogType).toBe('music.playlist');
  });

  it('falls back to the first track cover when the playlist has none', () => {
    const view = mapSharedPlaylist({
      name: 'Mix',
      coverArt: null,
      songs: [{ id: 's1', title: 'A', artist: 'X', coverArt: 'covA' }],
    });
    expect(view.coverId).toBe('covA');
    expect(view.subtitle).toBe('1 track');
  });

  it('handles an empty playlist without throwing', () => {
    const view = mapSharedPlaylist({ name: 'Empty', coverArt: null, songs: [] });
    expect(view.tracks).toEqual([]);
    expect(view.coverId).toBeNull();
    expect(view.subtitle).toBe('0 tracks');
  });
});
