import { describe, expect, it } from 'bun:test';
import {
  parseDiscogsRef,
  buildSearchParams,
  scoreSearchHit,
  selectBestRelease,
  mapReleaseGenres,
  foldArtist,
  foldTitle,
  type DiscogsSearchHit,
} from './matching.js';

const hit = (over: Partial<DiscogsSearchHit>): DiscogsSearchHit => ({
  id: 1,
  type: 'release',
  title: 'Artist - Album',
  ...over,
});

describe('parseDiscogsRef', () => {
  it('parses human release / master / artist URLs', () => {
    expect(parseDiscogsRef('https://www.discogs.com/release/249504-Rick-Astley')).toEqual({
      kind: 'release',
      id: 249504,
    });
    expect(parseDiscogsRef('https://www.discogs.com/master/96559')).toEqual({
      kind: 'master',
      id: 96559,
    });
    expect(parseDiscogsRef('https://www.discogs.com/artist/72872-Aphex-Twin')).toEqual({
      kind: 'artist',
      id: 72872,
    });
  });

  it('parses API-shaped URLs (plural path segments)', () => {
    expect(parseDiscogsRef('https://api.discogs.com/releases/249504')).toEqual({
      kind: 'release',
      id: 249504,
    });
    expect(parseDiscogsRef('https://api.discogs.com/masters/96559')).toEqual({
      kind: 'master',
      id: 96559,
    });
  });

  it('returns null for a non-entity URL', () => {
    expect(parseDiscogsRef('https://www.discogs.com/search?q=x')).toBeNull();
    expect(parseDiscogsRef('not a url')).toBeNull();
  });
});

describe('foldArtist / foldTitle', () => {
  it('folds accents and case', () => {
    expect(foldArtist('José Larralde')).toBe('jose larralde');
    expect(foldTitle('Ídolo')).toBe('idolo');
  });

  it('keeps artist punctuation but drops title punctuation', () => {
    // Artist fold preserves "!" (Miranda! ≠ Miranda); title fold strips it.
    expect(foldArtist('Miranda!')).toBe('miranda!');
    expect(foldTitle('Album: The Remixes!')).toBe('album the remixes');
  });
});

describe('buildSearchParams', () => {
  it('builds a release name search', () => {
    expect(buildSearchParams({ artist: 'La Konga', album: 'La Big Bang' })).toEqual({
      artist: 'La Konga',
      release_title: 'La Big Bang',
      type: 'release',
      per_page: '10',
    });
  });
});

describe('scoreSearchHit', () => {
  const query = { artist: 'José Larralde', album: 'Herencia Pa un Hijo Gaucho' };

  it('scores an exact artist+album match at 1', () => {
    expect(
      scoreSearchHit(query, hit({ title: 'José Larralde - Herencia Pa un Hijo Gaucho' })),
    ).toBe(1);
  });

  it('scores zero when the album does not corroborate (right artist, wrong release)', () => {
    // The Swedish-Emilia trap in miniature: artist matches, album does not.
    expect(scoreSearchHit(query, hit({ title: 'José Larralde - Some Other Record' }))).toBe(0);
  });

  it('scores zero when the artist does not corroborate', () => {
    expect(scoreSearchHit(query, hit({ title: 'Someone Else - Herencia Pa un Hijo Gaucho' }))).toBe(
      0,
    );
  });
});

describe('selectBestRelease', () => {
  it('rejects the same-name-different-release false match (Emilia AR vs SE)', () => {
    // Argentine Emilia's release; the search also returns Swedish Emilia's hit.
    const query = { artist: 'Emilia', album: 'Tú Crees en Mí' };
    const hits = [
      hit({ id: 11, title: 'Emilia - Big Big World' }), // Swedish Emilia — wrong album
      hit({ id: 22, title: 'Emilia - Tú Crees en Mí' }), // the right one
    ];
    expect(selectBestRelease(query, hits)).toEqual({
      ref: { kind: 'release', id: 22 },
      confidence: 1,
    });
  });

  it('returns null when nothing clears the confidence floor', () => {
    const query = { artist: 'Emilia', album: 'Tú Crees en Mí' };
    const hits = [hit({ id: 11, title: 'Emilia - Big Big World' })];
    expect(selectBestRelease(query, hits)).toBeNull();
  });

  it('prefers a master over a release on an equal score', () => {
    const query = { artist: 'Daft Punk', album: 'Discovery' };
    const hits = [
      hit({ id: 1, type: 'release', title: 'Daft Punk - Discovery' }),
      hit({ id: 2, type: 'master', title: 'Daft Punk - Discovery' }),
    ];
    expect(selectBestRelease(query, hits)?.ref).toEqual({ kind: 'master', id: 2 });
  });

  it('ignores non-release hit types (artist/label)', () => {
    const query = { artist: 'Daft Punk', album: 'Discovery' };
    const hits = [hit({ id: 9, type: 'artist', title: 'Daft Punk' })];
    expect(selectBestRelease(query, hits)).toBeNull();
  });
});

describe('mapReleaseGenres', () => {
  it('extracts + de-duplicates genres and styles', () => {
    expect(
      mapReleaseGenres({
        genres: ['Folk, World, & Country', 'Folk, World, & Country'],
        styles: ['Chamamé', ' Folclore '],
      }),
    ).toEqual({
      genres: ['Folk, World, & Country'],
      styles: ['Chamamé', 'Folclore'],
    });
  });

  it('tolerates missing arrays', () => {
    expect(mapReleaseGenres({})).toEqual({ genres: [], styles: [] });
  });
});
