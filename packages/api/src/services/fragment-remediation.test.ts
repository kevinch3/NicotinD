import { describe, expect, it, mock } from 'bun:test';
import { Database } from 'bun:sqlite';
import {
  applyMissplitMerge,
  missplitClusterMembers,
  suggestAlbumArtist,
} from './fragment-remediation.js';

function makeDb(): Database {
  const db = new Database(':memory:');
  db.run(`CREATE TABLE library_albums (
    id TEXT PRIMARY KEY, name TEXT, artist TEXT, classification TEXT, song_count INTEGER,
    hidden INTEGER DEFAULT 0, manual_override INTEGER DEFAULT 0)`);
  db.run(`CREATE TABLE library_songs (
    id TEXT PRIMARY KEY, album_id TEXT, title TEXT, artist TEXT, path TEXT)`);
  return db;
}

function seedPavarottiShape(db: Database): void {
  // One real 6-track member + two 1-track credit-variant strays + an
  // unrelated same-era album that must never be swept in.
  db.run(`INSERT INTO library_albums VALUES
    ('main', 'The Best', 'Luciano Pavarotti', 'ep', 6, 0, 0),
    ('strayA', 'The Best', 'Luciano Pavarotti, Berliner Philharmoniker', 'single', 1, 0, 0),
    ('strayB', 'The Best', 'Luciano Pavarotti, London Symphony Orchestra', 'single', 1, 0, 0),
    ('other', 'Completely Different', 'Someone Else', 'album', 10, 0, 0)`);
  db.run(`INSERT INTO library_songs VALUES
    ('s1', 'main', 'Caruso', 'Luciano Pavarotti', 'LP/The Best/01.mp3'),
    ('s2', 'strayA', 'Che gelida manina', 'Luciano Pavarotti, Berliner Philharmoniker', 'LPB/The Best/06.mp3'),
    ('s3', 'strayB', 'La Donna e Mobile', 'Luciano Pavarotti, London Symphony Orchestra', 'LPL/The Best/01.mp3')`);
}

describe('missplitClusterMembers', () => {
  it('returns every album sharing the normalized title, flagging the 1-track singles', () => {
    const db = makeDb();
    seedPavarottiShape(db);
    const members = missplitClusterMembers(db, 'the best');
    expect(members.map((m) => m.albumId).sort()).toEqual(['main', 'strayA', 'strayB']);
    const flagged = members.filter((m) => m.flagged).map((m) => m.albumId);
    expect(flagged.sort()).toEqual(['strayA', 'strayB']);
    // Paths ride along so the apply step can retag without a second lookup.
    expect(members.find((m) => m.albumId === 'strayA')?.paths).toEqual(['LPB/The Best/06.mp3']);
  });

  it('never matches an unrelated title', () => {
    const db = makeDb();
    seedPavarottiShape(db);
    expect(missplitClusterMembers(db, 'completely different').length).toBe(1);
    expect(missplitClusterMembers(db, 'nope')).toEqual([]);
  });
});

describe('suggestAlbumArtist', () => {
  it('suggests the dominant member artist when one member is a real album', () => {
    const db = makeDb();
    seedPavarottiShape(db);
    expect(suggestAlbumArtist(missplitClusterMembers(db, 'the best'))).toBe('Luciano Pavarotti');
  });

  it('falls back to Various Artists when every member is a fragment', () => {
    const db = makeDb();
    db.run(`INSERT INTO library_albums VALUES
      ('a', 'Latin Only', 'Gilda', 'single', 1, 0, 0),
      ('b', 'Latin Only', 'Onda Sabanera', 'single', 1, 0, 0),
      ('c', 'Latin Only', 'Mr. Grato', 'single', 1, 0, 0)`);
    expect(suggestAlbumArtist(missplitClusterMembers(db, 'latin only'))).toBe('Various Artists');
  });
});

describe('applyMissplitMerge', () => {
  it('retags every song of the selected albums with the target albumArtist', async () => {
    const db = makeDb();
    seedPavarottiShape(db);
    const writeTags = mock(async () => true);
    const result = await applyMissplitMerge(
      db,
      '/music',
      ['strayA', 'strayB'],
      'Luciano Pavarotti',
      writeTags,
    );
    expect(result.tagged).toBe(2);
    expect(result.failed).toBe(0);
    expect(writeTags).toHaveBeenCalledWith('/music/LPB/The Best/06.mp3', {
      albumArtist: 'Luciano Pavarotti',
    });
  });

  it('adds the compilation flag when merging into Various Artists', async () => {
    const db = makeDb();
    db.run(`INSERT INTO library_albums VALUES ('a', 'Latin Only', 'Gilda', 'single', 1, 0, 0)`);
    db.run(`INSERT INTO library_songs VALUES ('s', 'a', 'x', 'Gilda', 'G/Latin Only/99.mp3')`);
    const writeTags = mock(async () => true);
    await applyMissplitMerge(db, '/music', ['a'], 'Various Artists', writeTags);
    expect(writeTags).toHaveBeenCalledWith('/music/G/Latin Only/99.mp3', {
      albumArtist: 'Various Artists',
      compilation: true,
    });
  });

  it('counts a failed tag write without aborting the rest', async () => {
    const db = makeDb();
    seedPavarottiShape(db);
    let first = true;
    const writeTags = mock(async () => {
      if (first) {
        first = false;
        return false;
      }
      return true;
    });
    const result = await applyMissplitMerge(
      db,
      '/music',
      ['strayA', 'strayB'],
      'Luciano Pavarotti',
      writeTags,
    );
    expect(result.tagged).toBe(1);
    expect(result.failed).toBe(1);
  });
});
