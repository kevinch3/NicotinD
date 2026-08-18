import { describe, it, expect, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { getArtistOrigin, listOriginFacets, upsertArtistOrigin } from './artist-origins.js';

function seedArtist(db: Database, id: string, name: string, hidden = 0): void {
  db.run(
    `INSERT INTO library_artists (id, name, album_count, hidden, synced_at) VALUES (?, ?, 1, ?, 0)`,
    [id, name, hidden],
  );
}

describe('artist-origins service', () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db);
  });

  it('round-trips a country with provenance', () => {
    upsertArtistOrigin(db, { artistId: 'a1', country: 'AR', source: 'musicbrainz' });
    const row = getArtistOrigin(db, 'a1');
    expect(row).toMatchObject({ country: 'AR', source: 'musicbrainz' });
    expect(row!.checkedAt).toBeGreaterThan(0);
  });

  it('stores a tombstone (country null) distinguishable from no row', () => {
    upsertArtistOrigin(db, { artistId: 'a1', country: null, source: 'musicbrainz' });
    expect(getArtistOrigin(db, 'a1')).toMatchObject({ country: null });
    expect(getArtistOrigin(db, 'missing')).toBe(null);
  });

  it('a user row overwrites a musicbrainz row, but never the reverse', () => {
    upsertArtistOrigin(db, { artistId: 'a1', country: 'AR', source: 'musicbrainz' });
    upsertArtistOrigin(db, { artistId: 'a1', country: 'CL', source: 'user' });
    expect(getArtistOrigin(db, 'a1')).toMatchObject({ country: 'CL', source: 'user' });
    upsertArtistOrigin(db, { artistId: 'a1', country: 'AR', source: 'musicbrainz' });
    expect(getArtistOrigin(db, 'a1')).toMatchObject({ country: 'CL', source: 'user' });
  });

  it('facets count artists per country plus the unknown bucket', () => {
    seedArtist(db, 'a1', 'Uno');
    seedArtist(db, 'a2', 'Dos');
    seedArtist(db, 'a3', 'Tres');
    seedArtist(db, 'a4', 'Oculto', 1);
    upsertArtistOrigin(db, { artistId: 'a1', country: 'AR', source: 'musicbrainz' });
    upsertArtistOrigin(db, { artistId: 'a2', country: 'AR', source: 'user' });
    // Tombstone = unknown; a4 hidden and excluded entirely.
    upsertArtistOrigin(db, { artistId: 'a3', country: null, source: 'musicbrainz' });
    const facets = listOriginFacets(db);
    expect(facets.countries).toEqual([{ country: 'AR', artists: 2 }]);
    expect(facets.unknownArtists).toBe(1);
  });
});
