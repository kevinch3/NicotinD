import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { applySchema } from './db.js';

describe('applySchema — classification ep migration', () => {
  it('allows ep on a fresh database', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
       VALUES ('a', 'EP', 'X', 'art', 4, 0, 'ep', 1)`,
    );
    expect(db.query('SELECT classification FROM library_albums WHERE id = ?').get('a')).toEqual({
      classification: 'ep',
    });
  });

  it('rebuilds an old (pre-ep) table to allow ep while preserving rows', () => {
    const db = new Database(':memory:');
    // Simulate the legacy schema with the old CHECK constraint.
    db.run(`
      CREATE TABLE library_albums (
        id              TEXT PRIMARY KEY,
        name            TEXT NOT NULL,
        artist          TEXT NOT NULL,
        artist_id       TEXT NOT NULL,
        cover_art       TEXT,
        song_count      INTEGER NOT NULL DEFAULT 0,
        duration        INTEGER NOT NULL DEFAULT 0,
        year            INTEGER,
        genre           TEXT,
        created         TEXT,
        starred         TEXT,
        classification  TEXT NOT NULL DEFAULT 'unknown'
                            CHECK (classification IN ('album','single','compilation','unknown')),
        hidden          INTEGER NOT NULL DEFAULT 0,
        manual_override INTEGER NOT NULL DEFAULT 0,
        synced_at       INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, hidden, manual_override, synced_at)
       VALUES ('keep', 'Discovery', 'Daft Punk', 'art', 14, 0, 'album', 1, 1, 1)`,
    );

    applySchema(db);

    // Row preserved (incl. curation columns) and 'ep' now accepted.
    expect(
      db.query<{ classification: string; hidden: number; manual_override: number }, [string]>(
        'SELECT classification, hidden, manual_override FROM library_albums WHERE id = ?',
      ).get('keep'),
    ).toEqual({ classification: 'album', hidden: 1, manual_override: 1 });

    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
       VALUES ('ep1', 'My EP', 'X', 'art', 4, 0, 'ep', 1)`,
    );
    expect(db.query('SELECT classification FROM library_albums WHERE id = ?').get('ep1')).toEqual({
      classification: 'ep',
    });

    // Migration is idempotent — running again is a no-op.
    expect(() => applySchema(db)).not.toThrow();
  });
});
