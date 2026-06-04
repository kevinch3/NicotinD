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
      db
        .query<
          { classification: string; hidden: number; manual_override: number },
          [string]
        >('SELECT classification, hidden, manual_override FROM library_albums WHERE id = ?')
        .get('keep'),
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

describe('applySchema — playlists schema migration', () => {
  it('rebuilds old playlists table (no description column) and allows inserts', () => {
    const db = new Database(':memory:');
    db.run('PRAGMA foreign_keys=ON');
    // Seed old schema (as it existed in production DBs from pre-native-playlists era).
    db.run(
      `CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)`,
    );
    db.run(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'h')`);
    db.run(`
      CREATE TABLE playlists (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.run(`
      CREATE TABLE playlist_songs (
        playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
        song_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (playlist_id, song_id)
      )
    `);

    applySchema(db);

    // New schema should allow description, modified_at, INTEGER timestamps.
    expect(() =>
      db.run(
        `INSERT INTO playlists (id, user_id, name, description, created_at, modified_at) VALUES ('p1', 'u1', 'Test', 'desc', 1, 2)`,
      ),
    ).not.toThrow();

    // playlist_songs must accept added_at column.
    expect(() =>
      db.run(
        `INSERT INTO playlist_songs (playlist_id, song_id, position, added_at) VALUES ('p1', 's1', 0, 3)`,
      ),
    ).not.toThrow();

    // Migration is idempotent.
    expect(() => applySchema(db)).not.toThrow();
  });

  it('leaves an already-correct playlists table untouched', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'h')`);
    db.run(
      `INSERT INTO playlists (id, user_id, name, description, created_at, modified_at) VALUES ('p1', 'u1', 'T', null, 1, 2)`,
    );
    // Second applySchema should not drop the row.
    applySchema(db);
    expect(db.query('SELECT COUNT(*) AS c FROM playlists').get()).toEqual({ c: 1 });
  });
});

describe('applySchema — acquire_jobs backend CHECK relaxation', () => {
  it('rebuilds a legacy acquire_jobs table to allow open plugin-id backends', () => {
    const db = new Database(':memory:');
    // Simulate the legacy schema with the restrictive backend CHECK.
    db.run(`
      CREATE TABLE acquire_jobs (
        id          TEXT PRIMARY KEY,
        backend     TEXT NOT NULL CHECK (backend IN ('ytdlp', 'spotdl')),
        url         TEXT NOT NULL,
        label       TEXT,
        state       TEXT NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('queued', 'running', 'done', 'failed')),
        progress    TEXT,
        error       TEXT,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('legacy', 'ytdlp', 'u')`);

    applySchema(db);

    // Legacy row preserved.
    expect(db.query('SELECT COUNT(*) AS c FROM acquire_jobs').get()).toEqual({ c: 1 });
    // A new plugin id (not in the old CHECK set) is now accepted.
    expect(() =>
      db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('new', 'bandcamp', 'u')`),
    ).not.toThrow();
    // The state CHECK is still enforced.
    expect(() =>
      db.run(
        `INSERT INTO acquire_jobs (id, backend, url, state) VALUES ('bad', 'ytdlp', 'u', 'bogus')`,
      ),
    ).toThrow();
  });

  it('allows open backends on a fresh database', () => {
    const db = new Database(':memory:');
    applySchema(db);
    expect(() =>
      db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('x', 'bandcamp', 'u')`),
    ).not.toThrow();
  });
});
