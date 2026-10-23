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
  it('maps a network song to an enqueue candidate, labelled with the name it is given', () => {
    const c = songResultToCandidate(song(), 'Demo Source');
    expect(c.source).toBe('network');
    // The network lane has no fixed brand: the label is the addon's manifest name.
    expect(c.sourceLabel).toBe('Demo Source');
    expect(c.acquire).toEqual({
      via: 'enqueue',
      username: 'peer',
      file: { filename: 'Artist/Song.flac', size: 100 },
    });
    expect(c.format).toBe('FLAC');
  });

  it('scores FLAC + free slot above lossy + no slot', () => {
    const flac = songResultToCandidate(song({ filename: 'a.flac', freeUploadSlots: 1 }), 'Net');
    const mp3 = songResultToCandidate(
      song({ filename: 'a.mp3', bitRate: 192, freeUploadSlots: 0 }),
      'Net',
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
    const flacSong = songResultToCandidate(song({ filename: 'a.flac', freeUploadSlots: 1 }), 'Net');
    const archive = archiveToCandidate({
      identifier: 'p',
      title: 'P',
      creator: 'A',
      year: null,
      detailsUrl: 'u',
    });
    const merged = mergeAndRank([archive], [flacSong]);
    expect(merged[0].source).toBe('network'); // FLAC+slot (95) > archive (62)
    expect(merged).toHaveLength(2);
  });

  it('ranks a relevant lossy copy above an irrelevant FLAC with a free slot', () => {
    const relevant = songResultToCandidate(
      {
        ...song({ filename: 'a.mp3', bitRate: 320, freeUploadSlots: 0 }),
        relevance: 6,
      },
      'Net',
    );
    const flac = songResultToCandidate({ ...song({ filename: 'b.flac' }), relevance: 0 }, 'Net');
    expect(mergeAndRank([flac, relevant])[0]).toBe(relevant);
  });

  // #1537: a title tiebreak sorted equal-score rows alphabetically, so
  // "[untitled]" led a search for "Damian Lazarus".
  it('keeps the source order for equal scores instead of sorting by title', () => {
    const b = songResultToCandidate({ ...song(), title: 'Zebra' }, 'Net');
    const a = songResultToCandidate({ ...song(), title: '[untitled]' }, 'Net');
    expect(mergeAndRank([b, a]).map((c) => c.title)).toEqual(['Zebra', '[untitled]']);
  });

  it('names only the first-party lanes — the network lane is named by its addon', () => {
    expect(Object.keys(SOURCE_LABELS)).toEqual(['archive', 'spotify']);
  });
});
