import { describe, expect, it, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { mutateArtistOrigin } from './artist-origin-mutate.js';
import { getArtistOrigin, upsertArtistOrigin } from './artist-origins.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  applySchema(db);
  db.run(
    `INSERT INTO library_artists (id, name, album_count, hidden, synced_at) VALUES ('a1', 'Emilia', 0, 0, 1)`,
  );
});

describe('mutateArtistOrigin (#759)', () => {
  it('writes a normalized country as a user decision', () => {
    const r = mutateArtistOrigin(db, 'a1', 'ar');
    expect(r.ok).toBe(true);
    expect(getArtistOrigin(db, 'a1')).toMatchObject({ country: 'AR', source: 'user' });
  });

  it('reports what it replaced, so a wrong MBID is visible as the cause', () => {
    upsertArtistOrigin(db, { artistId: 'a1', country: 'SE', source: 'musicbrainz' });
    const r = mutateArtistOrigin(db, 'a1', 'AR');
    expect(r.ok && r.previous).toMatchObject({ country: 'SE', source: 'musicbrainz' });
  });

  /**
   * `null` is a decision, not an absence: it writes the permanent user
   * tombstone that stops the MusicBrainz pass re-deriving the wrong country.
   */
  it('tombstones on an explicit null', () => {
    const r = mutateArtistOrigin(db, 'a1', null);
    expect(r.ok).toBe(true);
    expect(getArtistOrigin(db, 'a1')).toMatchObject({ country: null, source: 'user' });
  });

  it('and that tombstone survives a later musicbrainz pass', () => {
    mutateArtistOrigin(db, 'a1', null);
    upsertArtistOrigin(db, { artistId: 'a1', country: 'SE', source: 'musicbrainz' });
    expect(getArtistOrigin(db, 'a1')).toMatchObject({ country: null, source: 'user' });
  });

  it('distinguishes a missing country from an explicit null', () => {
    const r = mutateArtistOrigin(db, 'a1', undefined);
    expect(r).toMatchObject({ ok: false, status: 400 });
  });

  it('rejects a non-ISO code', () => {
    expect(mutateArtistOrigin(db, 'a1', 'Argentina')).toMatchObject({ ok: false, status: 400 });
    expect(getArtistOrigin(db, 'a1')).toBeNull();
  });

  it('404s an unknown artist', () => {
    expect(mutateArtistOrigin(db, 'nope', 'AR')).toMatchObject({ ok: false, status: 404 });
  });
});
