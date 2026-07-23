import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';

import { applySchema } from '../db.js';
import { normalizeArtistForGrouping } from './album-grouping.js';
import { setSongGenres } from './genre-split.js';
import {
  applyGenreOverride,
  applySongGenreOverride,
  backfillGenreOverrides,
  buildOverrideIndex,
  emptyOverrideIndex,
  loadGenreOverrides,
  upsertGenreOverride,
  type GenreOverrideRow,
} from './genre-overrides.js';

const row = (
  p: Partial<GenreOverrideRow> & Pick<GenreOverrideRow, 'scope' | 'key'>,
): GenreOverrideRow => ({
  genres: ['Folclore'],
  source: 'musicbrainz',
  mbid: null,
  confidence: 0.8,
  status: 'applied',
  note: null,
  ...p,
});

const keys = { songId: 'song1', albumKey: 'alb1', artistKey: 'art1' };

describe('applyGenreOverride', () => {
  it('returns the tag genres unchanged when nothing is overridden', () => {
    expect(applyGenreOverride(emptyOverrideIndex(), keys, ['Latin', 'World'])).toEqual([
      'Latin',
      'World',
    ]);
  });

  it('REPLACES the set for a user override (the Larralde case)', () => {
    const ovr = buildOverrideIndex([
      row({ scope: 'artist', key: 'art1', genres: ['Folclore', 'Chacarera'], source: 'user' }),
    ]);
    // Not a merge: genreSetCloseness is a position-blind MAX over every pair, so
    // keeping 'Latin' would keep scoring 1.00 against every Latin track and mask
    // the correction entirely (measured on the real Larralde radio).
    expect(applyGenreOverride(ovr, keys, ['Latin', 'World'])).toEqual(['Folclore', 'Chacarera']);
  });

  it('prepends and keeps the tag genres for an AUTOMATED override', () => {
    // A machine picked these, so bound the damage: correct the primary without
    // destroying what the file already carried.
    const ovr = buildOverrideIndex([
      row({ scope: 'album', key: 'alb1', genres: ['Cumbia'], source: 'musicbrainz' }),
    ]);
    expect(applyGenreOverride(ovr, keys, ['Latin', 'World'])).toEqual(['Cumbia', 'Latin', 'World']);
  });

  it('dedupes case-insensitively against the tag genres (automated source)', () => {
    const ovr = buildOverrideIndex([
      row({ scope: 'artist', key: 'art1', genres: ['latin', 'Folk'] }),
    ]);
    expect(applyGenreOverride(ovr, keys, ['Latin', 'World'])).toEqual(['latin', 'Folk', 'World']);
  });

  it('prefers song over album over artist', () => {
    const all = buildOverrideIndex([
      row({ scope: 'artist', key: 'art1', genres: ['ArtistG'] }),
      row({ scope: 'album', key: 'alb1', genres: ['AlbumG'] }),
      row({ scope: 'song', key: 'song1', genres: ['SongG'] }),
    ]);
    expect(applyGenreOverride(all, keys, [])).toEqual(['SongG']);

    const albumAndArtist = buildOverrideIndex([
      row({ scope: 'artist', key: 'art1', genres: ['ArtistG'] }),
      row({ scope: 'album', key: 'alb1', genres: ['AlbumG'] }),
    ]);
    expect(applyGenreOverride(albumAndArtist, keys, [])).toEqual(['AlbumG']);
  });

  it('does not merge scopes — the most specific one wins outright', () => {
    const ovr = buildOverrideIndex([
      row({ scope: 'artist', key: 'art1', genres: ['ArtistG'] }),
      row({ scope: 'album', key: 'alb1', genres: ['AlbumG'] }),
    ]);
    expect(applyGenreOverride(ovr, keys, [])).not.toContain('ArtistG');
  });

  it('suppresses every genre when the override is empty (junk drop)', () => {
    const ovr = buildOverrideIndex([row({ scope: 'album', key: 'alb1', genres: [] })]);
    expect(applyGenreOverride(ovr, keys, ['Soundtrack', 'Other'])).toEqual([]);
  });

  it('ignores pending and rejected rows entirely', () => {
    const ovr = buildOverrideIndex([
      row({ scope: 'artist', key: 'art1', genres: ['Nope'], status: 'pending' }),
      row({ scope: 'album', key: 'alb1', genres: ['AlsoNope'], status: 'rejected' }),
    ]);
    expect(applyGenreOverride(ovr, keys, ['Latin'])).toEqual(['Latin']);
  });

  it('applies to a song whose keys match only by artist', () => {
    const ovr = buildOverrideIndex([row({ scope: 'artist', key: 'art1', genres: ['Folclore'] })]);
    expect(
      applyGenreOverride(ovr, { ...keys, songId: 'other', albumKey: 'other' }, ['Latin']),
    ).toEqual(['Folclore', 'Latin']);
  });
});

describe('upsertGenreOverride', () => {
  const freshDb = (): Database => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE library_genre_overrides (
        scope TEXT NOT NULL, key TEXT NOT NULL, genres TEXT NOT NULL,
        source TEXT NOT NULL, mbid TEXT, confidence REAL, status TEXT NOT NULL,
        note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        PRIMARY KEY (scope, key)
      )`);
    return db;
  };

  it('never lets an automated source overwrite a user decision', () => {
    const db = freshDb();
    upsertGenreOverride(
      db,
      row({ scope: 'artist', key: 'art1', genres: ['Folclore'], source: 'user' }),
    );
    const wrote = upsertGenreOverride(
      db,
      row({ scope: 'artist', key: 'art1', genres: ['Latin'], source: 'musicbrainz' }),
    );
    expect(wrote).toBe(false);
    expect(loadGenreOverrides(db).artist.get('art1')?.genres).toEqual(['Folclore']);
  });

  it('lets a user decision overwrite an automated one', () => {
    const db = freshDb();
    upsertGenreOverride(db, row({ scope: 'artist', key: 'art1', genres: ['Latin'] }));
    expect(
      upsertGenreOverride(
        db,
        row({ scope: 'artist', key: 'art1', genres: ['Folclore'], source: 'user' }),
      ),
    ).toBe(true);
    expect(loadGenreOverrides(db).artist.get('art1')?.genres).toEqual(['Folclore']);
  });

  it('round-trips through the db and only surfaces applied rows', () => {
    const db = freshDb();
    upsertGenreOverride(db, row({ scope: 'album', key: 'alb1', genres: ['Cumbia'] }));
    upsertGenreOverride(
      db,
      row({ scope: 'artist', key: 'art1', genres: ['X'], status: 'pending' }),
    );
    const idx = loadGenreOverrides(db);
    expect(idx.album.get('alb1')?.genres).toEqual(['Cumbia']);
    expect(idx.artist.has('art1')).toBe(false);
  });

  it('returns an empty index on a db with no override table', () => {
    expect(loadGenreOverrides(new Database(':memory:')).artist.size).toBe(0);
  });
});

describe('backfillGenreOverrides', () => {
  it('applies an artist override to stored sets without a rescan', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
       VALUES ('alb', 'Herencia', 'José Larralde', 'art', 1, 100, '2024-01-01', 1)`,
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, album_artist, duration, path, size, bit_rate, suffix, content_type, created, synced_at, genre)
       VALUES ('s1', 'alb', 'T', 'José Larralde', 'art', 'José Larralde', 100, 'p', 1, 1, 'mp3', 'audio/mpeg', '2024-01-01', 1, 'Latin')`,
    );
    setSongGenres(db, 's1', ['Latin', 'World']);

    upsertGenreOverride(db, {
      scope: 'artist',
      key: normalizeArtistForGrouping('José Larralde'),
      genres: ['Folclore', 'Chacarera'],
      source: 'user',
      mbid: null,
      confidence: null,
      status: 'applied',
      note: null,
    });

    const res = backfillGenreOverrides(db, setSongGenres);
    expect(res.updated).toBe(1);
    expect(
      db
        .query<{ genre: string }, []>(
          `SELECT genre FROM library_song_genres WHERE song_id = 's1' ORDER BY position`,
        )
        .all()
        .map((r) => r.genre),
    ).toEqual(['Folclore', 'Chacarera']);
    expect(
      db.query<{ genre: string }, []>(`SELECT genre FROM library_songs WHERE id = 's1'`).get()
        ?.genre,
    ).toBe('Folclore');
  });

  it('is idempotent — a second run changes nothing', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, album_artist, duration, path, size, bit_rate, suffix, content_type, created, synced_at, genre)
       VALUES ('s1', 'alb', 'T', 'A', 'art', 'A', 100, 'p', 1, 1, 'mp3', 'audio/mpeg', '2024-01-01', 1, 'Rock')`,
    );
    setSongGenres(db, 's1', ['Rock']);
    upsertGenreOverride(db, {
      scope: 'artist',
      key: normalizeArtistForGrouping('A'),
      genres: ['Metal'],
      source: 'user',
      mbid: null,
      confidence: null,
      status: 'applied',
      note: null,
    });
    expect(backfillGenreOverrides(db, setSongGenres).updated).toBe(1);
    expect(backfillGenreOverrides(db, setSongGenres).updated).toBe(0);
  });

  it('does nothing when there are no overrides', () => {
    const db = new Database(':memory:');
    applySchema(db);
    expect(backfillGenreOverrides(db, setSongGenres)).toEqual({ scanned: 0, updated: 0 });
  });
});

describe('applySongGenreOverride', () => {
  it('applies a single song-scoped essentia override without touching other songs (issue #187 A2)', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
       VALUES ('alb', 'Album', 'A', 'art', 2, 200, '2024-01-01', 1)`,
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, album_artist, duration, path, size, bit_rate, suffix, content_type, created, synced_at, genre)
       VALUES ('s1', 'alb', 'T1', 'A', 'art', 'A', 100, 'p1', 1, 1, 'mp3', 'audio/mpeg', '2024-01-01', 1, NULL),
              ('s2', 'alb', 'T2', 'A', 'art', 'A', 100, 'p2', 1, 1, 'mp3', 'audio/mpeg', '2024-01-01', 1, NULL)`,
    );
    upsertGenreOverride(db, {
      scope: 'song',
      key: 's1',
      genres: ['Rock'],
      source: 'essentia',
      mbid: null,
      confidence: 0.82,
      status: 'applied',
      note: null,
    });
    const idx = loadGenreOverrides(db);

    const changed = applySongGenreOverride(db, setSongGenres, idx, {
      songId: 's1',
      albumKey: 'unused-album',
      artistKey: normalizeArtistForGrouping('A'),
    });

    expect(changed).toBe(true);
    expect(
      db
        .query<{ genre: string }, [string]>(`SELECT genre FROM library_song_genres WHERE song_id = ?`)
        .all('s1')
        .map((r) => r.genre),
    ).toEqual(['Rock']);
    // s2 was never touched.
    expect(
      db
        .query<{ genre: string }, [string]>(`SELECT genre FROM library_song_genres WHERE song_id = ?`)
        .all('s2'),
    ).toEqual([]);
  });

  it('returns false and writes nothing when the resolved set is unchanged', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, created, synced_at)
       VALUES ('alb', 'Album', 'A', 'art', 1, 100, '2024-01-01', 1)`,
    );
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, album_artist, duration, path, size, bit_rate, suffix, content_type, created, synced_at, genre)
       VALUES ('s1', 'alb', 'T', 'A', 'art', 'A', 100, 'p', 1, 1, 'mp3', 'audio/mpeg', '2024-01-01', 1, 'Rock')`,
    );
    setSongGenres(db, 's1', ['Rock']);

    const changed = applySongGenreOverride(db, setSongGenres, emptyOverrideIndex(), {
      songId: 's1',
      albumKey: 'alb',
      artistKey: 'art',
    });

    expect(changed).toBe(false);
  });
});
