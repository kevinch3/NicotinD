import { describe, expect, it } from 'bun:test';
import type { Song } from '@nicotind/core';
import { artistIndex, isoDate, toAlbumID3, toChild, type StarLookup } from './opensubsonic-map.js';

const song: Song = {
  id: 's1',
  title: 'Song',
  album: 'Album',
  albumId: 'al1',
  artist: 'A feat. B',
  artistId: 'ar1',
  artists: [
    { id: 'ar1', name: 'A', role: 'primary' },
    { id: 'ar2', name: 'B', role: 'featuring' },
  ],
  track: 3,
  disc: 1,
  size: 1234,
  contentType: 'audio/flac',
  suffix: 'flac',
  duration: 200,
  bitRate: 900,
  sampleRate: 44100,
  genres: ['Rock', 'Pop'],
  genre: 'Rock',
  path: 'A/Album/03 Song.flac',
  created: '2026-01-02T03:04:05Z',
};

describe('OpenSubsonic mapping', () => {
  it('maps a song to a Child with OpenSubsonic credits and the caller’s star', () => {
    const stars: StarLookup = {
      songs: new Map([['s1', '2026-02-01T00:00:00.000Z']]),
      albums: new Map(),
      artists: new Map(),
    };
    const c = toChild(song, stars);
    expect(c).toMatchObject({
      id: 's1',
      parent: 'al1',
      isDir: false,
      track: 3,
      discNumber: 1,
      coverArt: 'al1',
      duration: 200,
      bitRate: 900,
      samplingRate: 44100,
      type: 'music',
      mediaType: 'song',
      starred: '2026-02-01T00:00:00.000Z',
      created: '2026-01-02T03:04:05.000Z',
      genres: [{ name: 'Rock' }, { name: 'Pop' }],
      artists: [
        { id: 'ar1', name: 'A' },
        { id: 'ar2', name: 'B' },
      ],
    });
    expect(toChild(song).starred).toBeUndefined();
  });

  it('maps an album with its release type, falling back to the single artist credit', () => {
    const a = toAlbumID3({
      id: 'al1',
      name: 'EP',
      artist: 'A',
      artistId: 'ar1',
      songCount: 4,
      duration: 900,
      created: 'not a date',
      classification: 'ep',
    });
    expect(a).toMatchObject({
      id: 'al1',
      coverArt: 'al1',
      releaseTypes: ['EP'],
      isCompilation: false,
      artists: [{ id: 'ar1', name: 'A' }],
    });
    // `created` is required on AlbumID3, so an unparseable one becomes the epoch.
    expect(a.created).toBe('1970-01-01T00:00:00.000Z');
  });

  it('rejects unparseable dates instead of emitting garbage', () => {
    expect(isoDate(undefined)).toBeUndefined();
    expect(isoDate('')).toBeUndefined();
    expect(isoDate('2026-03-04T05:06:07.000Z')).toBe('2026-03-04T05:06:07.000Z');
  });

  it('indexes artists A–Z ignoring articles and accents, everything else under #', () => {
    const idx = artistIndex([
      { name: 'The Beatles' },
      { name: 'Ábba' },
      { name: '2Pac' },
      { name: 'Air' },
      { name: 'Los Fabulosos Cadillacs' },
    ]);
    expect(idx.map((i) => i.name)).toEqual(['A', 'B', 'F', '#']);
    expect(idx[0]?.artist.map((a) => a.name)).toEqual(['Ábba', 'Air']);
    expect(idx[3]?.artist.map((a) => a.name)).toEqual(['2Pac']);
  });
});
