import { describe, expect, it } from 'bun:test';
import {
  groupSongsByArtist,
  planGenreBackfill,
  resolveSongAbsPath,
} from './track-backfill.js';

describe('resolveSongAbsPath', () => {
  it('joins a relative path under the music dir', () => {
    expect(resolveSongAbsPath('/music', 'Artist/Album/01.opus')).toBe(
      '/music/Artist/Album/01.opus',
    );
  });

  it('passes an absolute path through unchanged', () => {
    expect(resolveSongAbsPath('/music', '/other/place/02.flac')).toBe('/other/place/02.flac');
  });

  it('normalizes backslashes to forward slashes', () => {
    expect(resolveSongAbsPath('/music', 'Artist\\Album\\03.mp3')).toBe(
      '/music/Artist/Album/03.mp3',
    );
  });
});

describe('groupSongsByArtist', () => {
  it('groups songs by normalized artist in first-seen order', () => {
    const groups = groupSongsByArtist([
      { id: '1', artist: 'Soda Stereo' },
      { id: '2', artist: 'Café Tacvba' },
      { id: '3', artist: 'soda  stereo' },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]!.artist).toBe('Soda Stereo');
    expect(groups[0]!.songs.map((s) => s.id)).toEqual(['1', '3']);
    expect(groups[1]!.artist).toBe('Café Tacvba');
  });

  it('drops songs with an empty or whitespace artist', () => {
    const groups = groupSongsByArtist([
      { id: '1', artist: '' },
      { id: '2', artist: '   ' },
      { id: '3', artist: 'Real Artist' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.songs.map((s) => s.id)).toEqual(['3']);
  });
});

describe('planGenreBackfill', () => {
  it('looks each artist up once and fans the genre out to all their songs', async () => {
    const calls: string[] = [];
    const lookup = async (artist: string): Promise<string | null> => {
      calls.push(artist);
      return artist === 'Bob Marley' ? 'Reggae' : null;
    };
    const { assignments, skippedArtists } = await planGenreBackfill(
      [
        { id: '1', artist: 'Bob Marley' },
        { id: '2', artist: 'Bob Marley' },
        { id: '3', artist: 'Unknown Band' },
      ],
      lookup,
    );
    // One lookup per artist, not per song.
    expect(calls).toEqual(['Bob Marley', 'Unknown Band']);
    expect(assignments.map((a) => [a.song.id, a.genre])).toEqual([
      ['1', 'Reggae'],
      ['2', 'Reggae'],
    ]);
    expect(skippedArtists).toEqual(['Unknown Band']);
  });

  it('returns no assignments when the lookup resolves nothing', async () => {
    const { assignments, skippedArtists } = await planGenreBackfill(
      [{ id: '1', artist: 'Nobody' }],
      async () => null,
    );
    expect(assignments).toEqual([]);
    expect(skippedArtists).toEqual(['Nobody']);
  });
});
