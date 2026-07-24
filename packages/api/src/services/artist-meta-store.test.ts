import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { getArtistMeta, upsertArtistMeta } from './artist-meta-store.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
});

describe('artist-meta-store', () => {
  it('returns null for an artist with no row', () => {
    expect(getArtistMeta(db, 'artist-1')).toBeNull();
  });

  it('writes and reads back a resolved bio', () => {
    upsertArtistMeta(db, {
      artistId: 'artist-1',
      bio: 'A bio',
      urls: ['https://x.com', 'https://y.com'],
      source: 'discogs',
    });
    const row = getArtistMeta(db, 'artist-1');
    expect(row?.bio).toBe('A bio');
    expect(row?.urls).toEqual(['https://x.com', 'https://y.com']);
    expect(row?.source).toBe('discogs');
    expect(row?.manualOverride).toBe(false);
  });

  it('writes a tombstone row (null bio, empty urls) for a confident miss', () => {
    upsertArtistMeta(db, { artistId: 'artist-2', bio: null, urls: [], source: 'discogs' });
    const row = getArtistMeta(db, 'artist-2');
    expect(row?.bio).toBeNull();
    expect(row?.urls).toEqual([]);
  });

  it('a background write never overwrites a manual_override row', () => {
    upsertArtistMeta(db, {
      artistId: 'artist-3',
      bio: 'Curator bio',
      urls: [],
      source: 'user',
      manualOverride: true,
    });
    upsertArtistMeta(db, { artistId: 'artist-3', bio: 'Discogs bio', urls: [], source: 'discogs' });
    expect(getArtistMeta(db, 'artist-3')?.bio).toBe('Curator bio');
  });

  it('a manual write always wins, even over an existing manual row', () => {
    upsertArtistMeta(db, {
      artistId: 'artist-4',
      bio: 'First edit',
      urls: [],
      source: 'user',
      manualOverride: true,
    });
    upsertArtistMeta(db, {
      artistId: 'artist-4',
      bio: 'Second edit',
      urls: [],
      source: 'user',
      manualOverride: true,
    });
    expect(getArtistMeta(db, 'artist-4')?.bio).toBe('Second edit');
  });

  it('parses malformed urls JSON gracefully instead of throwing', () => {
    db.run(
      `INSERT INTO library_artist_meta (artist_id, bio, urls, fetched_at, source, manual_override)
       VALUES (?, ?, ?, ?, ?, ?)`,
      ['artist-5', 'Bio', 'not-json', Date.now(), 'discogs', 0],
    );
    expect(() => getArtistMeta(db, 'artist-5')).not.toThrow();
    expect(getArtistMeta(db, 'artist-5')?.urls).toEqual([]);
  });
});
