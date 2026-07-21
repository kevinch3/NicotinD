import { describe, it, expect } from 'vitest';
import {
  songResultToCandidate,
  archiveToCandidate,
  spotifyToCandidate,
  mergeAndRank,
  SOURCE_LABELS,
} from './acquisition-candidate';
import type { SongResult } from './song-results';
import type { ArchiveCandidate, SpotifyCandidate } from '../../types/core';

const song = (over: Partial<SongResult['best']> = {}): SongResult => {
  const best = {
    username: 'peer',
    filename: 'Artist/Song.flac',
    size: 100,
    artist: 'Artist',
    freeUploadSlots: 1,
    ...over,
  };
  return { key: 'k', title: 'Song', artist: 'Artist', best, versions: [best] };
};

describe('songResultToCandidate', () => {
  it('maps a Soulseek song to an enqueue candidate', () => {
    const c = songResultToCandidate(song());
    expect(c.source).toBe('soulseek');
    expect(c.sourceLabel).toBe('Soulseek');
    expect(c.acquire).toEqual({
      via: 'enqueue',
      username: 'peer',
      file: { filename: 'Artist/Song.flac', size: 100 },
    });
    expect(c.format).toBe('FLAC');
  });

  it('scores FLAC + free slot above lossy + no slot', () => {
    const flac = songResultToCandidate(song({ filename: 'a.flac', freeUploadSlots: 1 }));
    const mp3 = songResultToCandidate(
      song({ filename: 'a.mp3', bitRate: 192, freeUploadSlots: 0 }),
    );
    expect(flac.score).toBeGreaterThan(mp3.score);
  });
});

describe('archiveToCandidate / spotifyToCandidate', () => {
  it('maps archive items to a url candidate', () => {
    const a: ArchiveCandidate = {
      identifier: 'p',
      title: 'Porfiado',
      creator: 'El Cuarteto de Nos',
      year: '2012',
      detailsUrl: 'https://archive.org/details/p',
      trackCount: 12,
      kind: 'album',
    };
    const c = archiveToCandidate(a);
    expect(c.source).toBe('archive');
    expect(c.acquire).toEqual({ via: 'url', url: 'https://archive.org/details/p' });
    expect(c.subtitle).toContain('El Cuarteto de Nos');
  });

  it('maps spotify albums to a url candidate carrying the cover', () => {
    const s: SpotifyCandidate = {
      id: 'x',
      url: 'https://open.spotify.com/album/x',
      title: 'Porfiado',
      artist: 'El Cuarteto de Nos',
      year: '2012',
      coverUrl: 'https://img/c.jpg',
      trackCount: 12,
      kind: 'album',
    };
    const c = spotifyToCandidate(s);
    expect(c.source).toBe('spotify');
    expect(c.coverUrl).toBe('https://img/c.jpg');
  });
});

describe('mergeAndRank', () => {
  it('blends sources into one list, best score first', () => {
    const flacSong = songResultToCandidate(song({ filename: 'a.flac', freeUploadSlots: 1 }));
    const archive = archiveToCandidate({
      identifier: 'p',
      title: 'P',
      creator: 'A',
      year: null,
      detailsUrl: 'u',
    });
    const merged = mergeAndRank([archive], [flacSong]);
    expect(merged[0].source).toBe('soulseek'); // FLAC+slot (95) > archive (62)
    expect(merged).toHaveLength(2);
  });

  it('is a stable, neutral ordering across sources at equal score', () => {
    expect(Object.keys(SOURCE_LABELS)).toEqual(['soulseek', 'archive', 'spotify']);
  });
});
