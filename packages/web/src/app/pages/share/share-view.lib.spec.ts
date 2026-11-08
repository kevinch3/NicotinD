import { describe, it, expect } from 'vitest';
import { mapSharedAlbum, mapSharedArtist, mapSharedPlaylist } from './share-view.lib';

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
    expect(view.cover?.coverArt).toBe('alb1');
    expect(view.ogType).toBe('music.album');
    expect(view.tracks).toHaveLength(1);
    expect(view.tracks[0].title).toBe('One More Time');
  });
});

// #1666: the guest's cover URL is built from these, so each carries the rev of
// the entity that owns it — the album for a song, the artist for a portrait.
describe('share cover identity', () => {
  it('carries the album, artist and first-track album revs', () => {
    expect(mapSharedAlbum({ id: 'alb1', coverArt: 'alb1', coverRev: 4, song: [] }).cover).toEqual({
      coverArt: 'alb1',
      coverRev: 4,
      kind: 'album',
      id: 'alb1',
    });
    expect(mapSharedArtist({ id: 'art1', coverRev: 2 }, []).cover).toEqual({
      coverArt: 'art1',
      coverRev: 2,
      kind: 'artist',
      id: 'art1',
    });
    const pl = mapSharedPlaylist({
      name: 'Mix',
      songs: [{ id: 's1', coverArt: 's1', coverRev: 6, albumId: 'al9' }],
    });
    expect(pl.cover).toEqual({ coverArt: 's1', coverRev: 6, kind: 'album', id: 'al9' });
  });
});

describe('mapSharedArtist', () => {
  it('maps name, album-count subtitle, id-keyed cover and a playable song list', () => {
    const view = mapSharedArtist(
      { id: 'art1', name: 'Daft Punk', albumCount: 2, bio: 'French duo.' },
      [{ id: 's1', title: 'One More Time', artist: 'Daft Punk', duration: 320 }],
    );
    expect(view.name).toBe('Daft Punk');
    expect(view.subtitle).toBe('2 albums');
    expect(view.cover?.coverArt).toBe('art1');
    expect(view.ogType).toBe('profile');
    expect(view.bio).toBe('French duo.');
    expect(view.ogDescription).toBe('French duo.');
    expect(view.tracks).toHaveLength(1);
    expect(view.tracks[0].title).toBe('One More Time');
  });

  it('singularizes a one-album artist and omits bio when absent', () => {
    const view = mapSharedArtist({ id: 'art2', name: 'Solo', albumCount: 1 }, []);
    expect(view.subtitle).toBe('1 album');
    expect(view.bio).toBeUndefined();
    expect(view.ogDescription).toBe('1 album');
    expect(view.tracks).toEqual([]);
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
    expect(view.cover?.coverArt).toBe('covA');
    expect(view.subtitle).toBe('1 track');
  });

  // A curated playlist's coverArt is its designed-cover URL, not a cover id:
  // through the id helper it became /api/cover//playlist-covers/… (a 404).
  it("shows a curated playlist's designed cover as is, og art from the first track", () => {
    const view = mapSharedPlaylist({
      name: 'Late Night',
      coverArt: '/playlist-covers/late-night.svg',
      songs: [{ id: 's1', title: 'A', artist: 'X', coverArt: 's1', coverRev: 2, albumId: 'al1' }],
    });
    expect(view.coverImage).toBe('/playlist-covers/late-night.svg');
    expect(view.cover).toEqual({ coverArt: 's1', coverRev: 2, kind: 'album', id: 'al1' });
  });

  it('handles an empty playlist without throwing', () => {
    const view = mapSharedPlaylist({ name: 'Empty', coverArt: null, songs: [] });
    expect(view.tracks).toEqual([]);
    expect(view.cover).toBeNull();
    expect(view.subtitle).toBe('0 tracks');
  });
});
