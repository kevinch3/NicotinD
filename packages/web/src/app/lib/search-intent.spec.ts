import { describe, it, expect } from 'vitest';
import { inferIntent, parseScope, searchTokens } from './search-intent';
import type { CatalogAlbum, CatalogSearchResult } from '../services/api/api-types';

const album = (title: string, artistName = 'Ennio Morricone'): CatalogAlbum =>
  ({ foreignAlbumId: title, title, artistName }) as CatalogAlbum;
const catalog = (over: Partial<CatalogSearchResult>): CatalogSearchResult => ({
  artists: [],
  albums: [],
  ...over,
});
const MORRICONE = { mbid: 'em', name: 'Ennio Morricone' };

describe('searchTokens', () => {
  it('drops accents, case, apostrophes and punctuation', () => {
    expect(searchTokens("L'estasi dell'oro — Él")).toEqual(['lestasi', 'delloro', 'el']);
  });
});

describe('parseScope', () => {
  it('reads a known scope and defaults anything else to all', () => {
    expect(parseScope('tracks')).toBe('tracks');
    expect(parseScope('albums')).toBe('albums');
    expect(parseScope('nonsense')).toBe('all');
    expect(parseScope(null)).toBe('all');
  });
});

describe('inferIntent', () => {
  const best = { id: 'track-1' };

  it('an artist query tops with the artist the catalog scoped to', () => {
    const c = catalog({
      artists: [MORRICONE],
      albums: [album('The Best of Ennio Morricone'), album('The Mission')],
      scopedArtist: 'Ennio Morricone',
    });
    expect(inferIntent('Ennio Morricone', c, best)).toEqual({ kind: 'artist', artist: MORRICONE });
  });

  it('an artist + album query tops with that album', () => {
    const named = album('The Best of Ennio Morricone');
    const c = catalog({
      artists: [MORRICONE],
      albums: [album('The Mission'), named],
      scopedArtist: 'Ennio Morricone',
    });
    expect(inferIntent('ennio morricone the best of ennio morricone', c, best)).toEqual({
      kind: 'album',
      album: named,
    });
  });

  it('a track query no album covers tops with the best track', () => {
    const c = catalog({
      artists: [MORRICONE],
      albums: [album('The Good, the Bad and the Ugly')],
      scopedArtist: 'Ennio Morricone',
    });
    expect(inferIntent("Ennio Morricone L'estasi dell'oro", c, best)).toEqual({
      kind: 'track',
      track: best,
    });
  });

  it('two different albums the query covers name neither', () => {
    const c = catalog({ albums: [album('Mission'), album('Morricone Mission')] });
    expect(inferIntent('morricone mission', c, null)).toBeNull();
  });

  it('an album titled after its artist is not named by the artist alone', () => {
    const c = catalog({ albums: [album('Ennio Morricone')] });
    expect(inferIntent('Ennio Morricone', c, best)).toEqual({ kind: 'track', track: best });
  });

  it('nothing to say for an empty query, or with no catalog and no track', () => {
    expect(inferIntent('  ', null, best)).toBeNull();
    expect(inferIntent('x', null, null)).toBeNull();
  });
});
