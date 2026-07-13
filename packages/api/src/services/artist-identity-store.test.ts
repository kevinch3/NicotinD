import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import {
  loadSplitAuthority,
  recordAcquiredArtistIdentity,
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
