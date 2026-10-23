import { describe, expect, it } from 'bun:test';
import { artistCredits, artistsOverlap, folderAlbumIdentity, sameAlbum } from './album-identity.js';

describe('artistCredits', () => {
  it('splits a collaboration credit into its acts, keeping the whole', () => {
    expect(artistCredits('Damian Lazarus & The Ancient Moons')).toEqual([
      'damian lazarus & the ancient moons',
      'damian lazarus',
      'the ancient moons',
    ]);
  });

  it('does not split inside a word', () => {
    expect(artistCredits('Xavier Rudd')).toEqual(['xavier rudd']);
  });
});

describe('artistsOverlap', () => {
  it('matches a lead act against its collaboration credit, diacritic-insensitive', () => {
    expect(artistsOverlap('Damian Lazarus', 'Damian Lazarus & The Ancient Moons')).toBe(true);
    expect(artistsOverlap('Christian Loffler', 'Christian Löffler feat. Mohna')).toBe(true);
  });

  it('keeps unrelated acts apart', () => {
    expect(artistsOverlap('Damian Lazarus', 'Damian Marley')).toBe(false);
  });
});

describe('sameAlbum', () => {
  // #1539: the prod duplicate — the catalog card vs the peer folder it was
  // already downloading from.
  it('matches a catalog naming against a peer folder naming of one album', () => {
    expect(
      sameAlbum(
        { artist: 'Damian Lazarus', title: 'Message From the Other Side' },
        {
          artist: 'Damian Lazarus & The Ancient Moons',
          title: 'Damian Lazarus & The Ancient Moons - Message From The Other Side [2015]',
        },
      ),
    ).toBe(true);
  });

  it('collapses editions the way the library groups them', () => {
    expect(
      sameAlbum(
        { artist: 'Christian Löffler', title: 'Mare' },
        { artist: 'Christian Loffler', title: 'Mare (Deluxe Edition)' },
      ),
    ).toBe(true);
  });

  it('keeps a distinct release by the same artist apart', () => {
    expect(
      sameAlbum(
        { artist: 'Christian Löffler', title: 'Mare' },
        { artist: 'Christian Löffler', title: 'Mare Reworks' },
      ),
    ).toBe(false);
  });

  it('keeps one title by two different artists apart', () => {
    expect(
      sameAlbum(
        { artist: 'Damian Lazarus', title: 'Heights' },
        { artist: 'Kaskade', title: 'Heights' },
      ),
    ).toBe(false);
  });

  it('never matches on a missing name', () => {
    expect(sameAlbum({ artist: '', title: 'Mare' }, { artist: '', title: 'Mare' })).toBe(false);
  });
});

describe('folderAlbumIdentity', () => {
  it('reads both names from an "Artist - Album [Year]" leaf', () => {
    expect(
      folderAlbumIdentity(
        '@@nncnz\\Johnson\\Flac albumi\\Elektronika\\Damian Lazarus & The Ancient Moons - Message From The Other Side [2015]',
      ),
    ).toEqual({
      artist: 'Damian Lazarus & The Ancient Moons',
      title: 'Message From The Other Side',
    });
  });

  it('falls back to parent = artist, leaf = album, dropping a date prefix', () => {
    expect(folderAlbumIdentity('music/Christian Löffler/2016 - Mare')).toEqual({
      artist: 'Christian Löffler',
      title: 'Mare',
    });
    expect(
      folderAlbumIdentity('music\\Christian Löffler\\2014.04.17 - Young Alaska [FLAC]'),
    ).toEqual({ artist: 'Christian Löffler', title: 'Young Alaska' });
    expect(folderAlbumIdentity('Kaskade/Redux')).toEqual({ artist: 'Kaskade', title: 'Redux' });
  });

  it('names nothing from generic containers', () => {
    expect(folderAlbumIdentity('music/FLAC')).toEqual({ artist: null, title: null });
  });
});
