import { describe, expect, it } from 'bun:test';
import { buildLibrary, artistIdFor, type ScannedTrack } from '../services/library-scanner.js';
import { compareCredits, type StoredLibrary } from './joint-credits-dry-run.js';

function track(p: Partial<ScannedTrack> & { relPath: string }): ScannedTrack {
  return {
    size: 1,
    mtimeMs: 1,
    suffix: 'opus',
    contentType: 'audio/ogg',
    duration: 200,
    bitRate: 128,
    ...p,
  };
}

const solo = track({
  relPath: 'G/E/01.opus',
  artist: 'Gramatik',
  albumArtist: 'Gramatik',
  album: 'E',
  title: 'Solo',
});
const duet = track({
  relPath: 'G/E/02.opus',
  artist: 'Gramatik/Luxas',
  albumArtist: 'Gramatik',
  album: 'E',
  title: 'Duet',
});
const built = buildLibrary([solo, duet]);
const id = (path: string) => built.songs.find((s) => s.path === path)!.id;
const album = built.songs[0]!.albumId;
const gramatik = artistIdFor('Gramatik');

const stored = (over: Partial<StoredLibrary> = {}): StoredLibrary => ({
  songs: [
    { id: id(solo.relPath), artist: 'Gramatik', albumId: album },
    { id: id(duet.relPath), artist: 'Gramatik/Luxas', albumId: album },
  ],
  songLinks: [
    { songId: id(solo.relPath), artistId: gramatik },
    { songId: id(duet.relPath), artistId: gramatik },
  ],
  artists: [
    {
      id: gramatik,
      name: 'Gramatik',
      albumCount: 1,
      hidden: 0,
      splitCompound: 0,
      fragmentOf: null,
      starred: null,
      manualOverride: 0,
    },
  ],
  ...over,
});

describe('compareCredits', () => {
  it('lists a credit that gains links, with its names before and after', () => {
    const report = compareCredits(built, stored());
    expect(report.songs).toMatchObject({
      total: 2,
      creditsChanged: 1,
      albumChanged: 0,
      missing: 0,
    });
    expect(report.changes).toEqual([
      { credit: 'Gramatik/Luxas', songs: 1, before: ['Gramatik'], after: ['Gramatik', 'Luxas'] },
    ]);
  });

  it('does not report a repeated name, which the database collapses to one link', () => {
    const once = compareCredits(
      { ...built, songArtists: [...built.songArtists, ...built.songArtists] },
      stored(),
    );
    expect(once.songs.creditsChanged).toBe(1);
    expect(once.changes[0]!.after).toEqual(['Gramatik', 'Luxas']);
  });

  it('counts new artists, separating guests the grid will not show', () => {
    const report = compareCredits(built, stored());
    expect(report.artists).toMatchObject({ added: 1, addedGuests: 1, newlyHidden: 0 });
    expect(report.addedNames).toEqual(['Luxas']);
    expect(report.grid).toEqual({ before: 1, after: 1 });
  });

  it('surfaces any album id that would move', () => {
    const report = compareCredits(
      built,
      stored({ songs: [{ id: id(solo.relPath), artist: 'Gramatik', albumId: 'other' }] }),
    );
    expect(report.songs.albumChanged).toBe(1);
  });

  it('names a removed artist row, and any curation it carries', () => {
    const gone = {
      id: 'gone',
      name: 'Gone/Name',
      albumCount: 1,
      hidden: 0,
      splitCompound: 0,
      fragmentOf: null,
      starred: '2026-01-01',
      manualOverride: 0,
    };
    const base = stored();
    const report = compareCredits(built, { ...base, artists: [...base.artists, gone] });
    expect(report.artists.removed).toBe(1);
    expect(report.removedCurated).toEqual(['Gone/Name']);
  });
});
