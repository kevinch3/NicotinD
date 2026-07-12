import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  deriveMbidAliases,
  loadSplitAuthority,
  recordAcquiredArtistIdentity,
  upsertArtistAlias,
  upsertArtistIdentity,
} from './artist-identity-store.js';
import { artistIdFor } from './library-scanner.js';

let db: Database;
beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

function seed(artist: string, albumArtist = artist): void {
  db.run(
    `INSERT INTO library_songs (id, album_id, title, artist, artist_id, album_artist, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
     VALUES (?, 'alb', 'T', ?, 'art', ?, 0, ?, 10, 320, 'opus', 'audio/opus', '2024-01-01', 1)`,
    [`${artist}-${Math.random()}`, artist, albumArtist, `${artist}/Album.opus`],
  );
}

describe('loadSplitAuthority', () => {
  it('confirms atomic library artist names but never a compound (self-confirmation guard)', () => {
    seed('Charly García');
    seed('Luis Alberto Spinetta');
    seed('Charly García y Luis Alberto Spinetta'); // compound — must NOT confirm itself
    const auth = loadSplitAuthority(db);
    expect(auth.confirmedArtists.has('charly garcia')).toBe(true);
    expect(auth.confirmedArtists.has('luis alberto spinetta')).toBe(true);
    expect(auth.confirmedArtists.has('charly garcia y luis alberto spinetta')).toBe(false);
  });

  it('contributes canonicalWhole from a "single" authority row', () => {
    upsertArtistIdentity(db, {
      artistKey: artistIdFor('Wisin & Yandel'),
      rawName: 'Wisin & Yandel',
      decision: 'single',
      source: 'lidarr',
    });
    const auth = loadSplitAuthority(db);
    expect(auth.canonicalWhole.has('wisin & yandel')).toBe(true);
  });

  it('contributes confirmed members from a "split" authority row', () => {
    upsertArtistIdentity(db, {
      artistKey: artistIdFor('Bob Marley, Peter Tosh'),
      rawName: 'Bob Marley, Peter Tosh',
      decision: 'split',
      members: ['Bob Marley', 'Peter Tosh'],
      source: 'lidarr',
    });
    const auth = loadSplitAuthority(db);
    expect(auth.confirmedArtists.has('bob marley')).toBe(true);
    expect(auth.confirmedArtists.has('peter tosh')).toBe(true);
  });

  it('ignores an "unknown" row (no opinion — leaves it to library-only logic)', () => {
    upsertArtistIdentity(db, {
      artistKey: artistIdFor('Some, Weird x Thing'),
      rawName: 'Some, Weird x Thing',
      decision: 'unknown',
      source: 'lidarr',
    });
    const auth = loadSplitAuthority(db);
    expect(auth.canonicalWhole.size).toBe(0);
    expect(auth.confirmedArtists.size).toBe(0);
  });
});

describe('upsertArtistIdentity precedence', () => {
  const key = artistIdFor('Bob Marley, Peter Tosh');
  const base = { artistKey: key, rawName: 'Bob Marley, Peter Tosh' };

  function decision(): { decision: string; source: string } | null {
    return db
      .query<{ decision: string; source: string }, [string]>(
        `SELECT decision, source FROM library_artist_identity WHERE artist_key = ?`,
      )
      .get(key);
  }

  it('a background write never clobbers a user decision; another user write can', () => {
    upsertArtistIdentity(db, { ...base, decision: 'single', source: 'user' });
    upsertArtistIdentity(db, {
      ...base,
      decision: 'split',
      members: ['Bob Marley', 'Peter Tosh'],
      source: 'lidarr',
    });
    expect(decision()).toEqual({ decision: 'single', source: 'user' });

    upsertArtistIdentity(db, {
      ...base,
      decision: 'split',
      members: ['Bob Marley', 'Peter Tosh'],
      source: 'user',
    });
    expect(decision()).toEqual({ decision: 'split', source: 'user' });
  });

  it('background writes still replace background rows', () => {
    upsertArtistIdentity(db, { ...base, decision: 'unknown', source: 'lidarr' });
    upsertArtistIdentity(db, { ...base, decision: 'single', source: 'lidarr' });
    expect(decision()).toEqual({ decision: 'single', source: 'lidarr' });
  });
});

describe('deriveMbidAliases', () => {
  /** Seed one library artist with `songs` songs and a cached MBID link. */
  function seedArtist(name: string, mbid: string, songs: number, albums = 0): void {
    const id = artistIdFor(name);
    db.run(
      `INSERT INTO library_artists (id, name, album_count, synced_at) VALUES (?, ?, ?, 1)`,
      [id, name, albums],
    );
    db.run(
      `INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at) VALUES (?, NULL, ?, 1)`,
      [id, mbid],
    );
    for (let i = 0; i < songs; i++) {
      db.run(
        `INSERT INTO library_songs (id, album_id, title, artist, artist_id, duration, path, size, bit_rate, suffix, content_type, created, synced_at)
         VALUES (?, 'alb', 'T', ?, ?, 0, ?, 10, 320, 'opus', 'audio/opus', '2024-01-01', 1)`,
        [`${name}-${i}`, name, id, `${name}/${i}.opus`],
      );
    }
  }

  it('proposes aliasing the fewer-songs spelling to the canonical one on MBID equality', () => {
    seedArtist('Snoop Dogg', 'mbid-snoop', 5);
    seedArtist('Snoop Dog', 'mbid-snoop', 1);
    seedArtist('Dr. Dre', 'mbid-dre', 3); // unique MBID — untouched

    const proposals = deriveMbidAliases(db);

    expect(proposals).toEqual([
      {
        aliasNorm: 'snoop dog',
        variantName: 'Snoop Dog',
        canonicalName: 'Snoop Dogg',
        mbid: 'mbid-snoop',
      },
    ]);
    // Proposals only — nothing written without apply (human-gated; see docblock).
    expect(loadSplitAuthority(db).aliases.size).toBe(0);

    deriveMbidAliases(db, { apply: true });
    const auth = loadSplitAuthority(db);
    expect(auth.aliases.get('snoop dog')).toBe('Snoop Dogg');
    expect(auth.aliases.has('snoop dogg')).toBe(false);
    expect(auth.aliases.has('dr. dre')).toBe(false);
  });

  it('never overwrites a user-sourced alias', () => {
    seedArtist('Snoop Dogg', 'mbid-snoop', 5);
    seedArtist('Snoop Dog', 'mbid-snoop', 1);
    upsertArtistAlias(db, {
      aliasNorm: 'snoop dog',
      canonicalName: 'Snoop D-O-Double-G',
      source: 'user',
    });

    deriveMbidAliases(db, { apply: true });

    expect(loadSplitAuthority(db).aliases.get('snoop dog')).toBe('Snoop D-O-Double-G');
  });

  it('proposes nothing when every MBID is unique', () => {
    seedArtist('Charly García', 'mbid-charly', 4);
    seedArtist('Fito Páez', 'mbid-fito', 2);
    expect(deriveMbidAliases(db, { apply: true })).toHaveLength(0);
    expect(loadSplitAuthority(db).aliases.size).toBe(0);
  });
});

describe('recordAcquiredArtistIdentity', () => {
  const key = artistIdFor('Bob Marley & The Wailers');

  it('writes a single/lidarr identity row and caches the MBID link', () => {
    recordAcquiredArtistIdentity(db, {
      artistKey: key,
      artistName: 'Bob Marley & The Wailers',
      mbid: 'mbid-wailers',
    });
    const identity = db
      .query<{ decision: string; source: string }, [string]>(
        'SELECT decision, source FROM library_artist_identity WHERE artist_key = ?',
      )
      .get(key);
    expect(identity).toEqual({ decision: 'single', source: 'lidarr' });
    const link = db
      .query<{ mbid: string }, [string]>(
        'SELECT mbid FROM artist_discography_links WHERE artist_id = ?',
      )
      .get(key);
    expect(link?.mbid).toBe('mbid-wailers');
    // The canonical compound is now protected as one act for the scanner.
    expect(loadSplitAuthority(db).canonicalWhole.has('bob marley & the wailers')).toBe(true);
  });

  it('preserves an existing lidarr_id when refreshing the MBID link', () => {
    db.run(
      `INSERT INTO artist_discography_links (artist_id, lidarr_id, mbid, checked_at) VALUES (?, 42, 'old', 1)`,
      [key],
    );
    recordAcquiredArtistIdentity(db, {
      artistKey: key,
      artistName: 'Bob Marley & The Wailers',
      mbid: 'new',
    });
    const link = db
      .query<{ lidarr_id: number | null; mbid: string }, [string]>(
        'SELECT lidarr_id, mbid FROM artist_discography_links WHERE artist_id = ?',
      )
      .get(key);
    expect(link).toEqual({ lidarr_id: 42, mbid: 'new' });
  });

  it('skips the link entirely when no MBID is available', () => {
    recordAcquiredArtistIdentity(db, { artistKey: key, artistName: 'Bob Marley & The Wailers' });
    const link = db
      .query<{ 1: number }, [string]>('SELECT 1 FROM artist_discography_links WHERE artist_id = ?')
      .get(key);
    expect(link).toBeNull();
    expect(
      db
        .query<
          { 1: number },
          [string]
        >('SELECT 1 FROM library_artist_identity WHERE artist_key = ?')
        .get(key),
    ).not.toBeNull();
  });
});
