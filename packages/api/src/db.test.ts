import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { addColumnIfMissing, applySchema } from './db.js';

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
        .query<{ classification: string; hidden: number; manual_override: number }, [string]>(
          'SELECT classification, hidden, manual_override FROM library_albums WHERE id = ?',
        )
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

describe('applySchema — share_tokens artist CHECK broadening (#229)', () => {
  it('allows an artist share row on a fresh database', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'a', 'h')`);
    expect(() =>
      db.run(
        `INSERT INTO share_tokens (token, resource_type, resource_id, created_by, created_at)
         VALUES ('t', 'artist', 'art1', 'u1', 1)`,
      ),
    ).not.toThrow();
  });

  it('rebuilds a legacy two-value-CHECK table to allow artist while preserving rows', () => {
    const db = new Database(':memory:');
    db.run(
      `CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL)`,
    );
    db.run(`INSERT INTO users (id, username, password_hash) VALUES ('u1', 'a', 'h')`);
    // Legacy schema with the old CHECK (playlist|album only).
    db.run(`
      CREATE TABLE share_tokens (
        token             TEXT    PRIMARY KEY,
        resource_type     TEXT    NOT NULL CHECK (resource_type IN ('playlist', 'album')),
        resource_id       TEXT    NOT NULL,
        created_by        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at        INTEGER NOT NULL,
        first_accessed_at INTEGER,
        expires_at        INTEGER
      )
    `);
    db.run(
      `INSERT INTO share_tokens (token, resource_type, resource_id, created_by, created_at)
       VALUES ('keep', 'album', 'al1', 'u1', 5)`,
    );

    applySchema(db);

    // Legacy row preserved.
    expect(db.query('SELECT COUNT(*) AS c FROM share_tokens').get()).toEqual({ c: 1 });
    // Artist rows now accepted.
    expect(() =>
      db.run(
        `INSERT INTO share_tokens (token, resource_type, resource_id, created_by, created_at)
         VALUES ('art', 'artist', 'art1', 'u1', 6)`,
      ),
    ).not.toThrow();
    // A bogus type is still rejected.
    expect(() =>
      db.run(
        `INSERT INTO share_tokens (token, resource_type, resource_id, created_by, created_at)
         VALUES ('bad', 'song', 'x', 'u1', 7)`,
      ),
    ).toThrow();
    // Idempotent.
    expect(() => applySchema(db)).not.toThrow();
  });
});

describe('applySchema — drops the dead tombstones table (§D2)', () => {
  it('drops a pre-existing library_album_tombstones table', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE library_album_tombstones (album_id TEXT PRIMARY KEY, created_at INTEGER)`);
    db.run(`INSERT INTO library_album_tombstones (album_id, created_at) VALUES ('a', 1)`);

    applySchema(db);

    const row = db
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='library_album_tombstones'`,
      )
      .get();
    expect(row).toBeNull();
  });

  it('is a no-op on a fresh database (table never created)', () => {
    const db = new Database(':memory:');
    expect(() => applySchema(db)).not.toThrow();
    const row = db
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='library_album_tombstones'`,
      )
      .get();
    expect(row).toBeNull();
  });
});

describe('applySchema — perceptual feature columns + embeddings table', () => {
  it('adds the seven feature columns and library_embeddings on a fresh database', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, energy, loudness,
         danceability, valence, acousticness, instrumental, mood, synced_at)
       VALUES ('s', 'a', 'T', 'X', 'art', 'p', 0.5, -10.1, 0.6, 0.4, 0.2, 0.9, 'happy', 1)`,
    );
    const row = db
      .query<{ energy: number; mood: string }, []>(
        `SELECT energy, mood FROM library_songs WHERE id = 's'`,
      )
      .get();
    expect(row?.energy).toBeCloseTo(0.5);
    expect(row?.mood).toBe('happy');

    db.run(
      `INSERT INTO library_embeddings (song_id, model, dim, vec, updated_at)
       VALUES ('s', 'discogs-effnet-bs64-1', 4, ?, 1)`,
      [Buffer.from(new Float32Array([1, 2, 3, 4]).buffer)],
    );
    const emb = db
      .query<{ dim: number }, []>(`SELECT dim FROM library_embeddings WHERE song_id = 's'`)
      .get();
    expect(emb?.dim).toBe(4);
  });

  it('is idempotent — a second applySchema on the same db does not throw', () => {
    const db = new Database(':memory:');
    applySchema(db);
    expect(() => applySchema(db)).not.toThrow();
  });

  it('backfills the columns onto a legacy library_songs table', () => {
    const db = new Database(':memory:');
    // Minimal legacy table without the feature columns.
    db.run(`
      CREATE TABLE library_songs (
        id TEXT PRIMARY KEY, album_id TEXT NOT NULL, title TEXT NOT NULL,
        artist TEXT NOT NULL, artist_id TEXT NOT NULL, track INTEGER, disc INTEGER,
        duration INTEGER NOT NULL DEFAULT 0, year INTEGER, genre TEXT, cover_art TEXT,
        path TEXT NOT NULL, size INTEGER, bit_rate INTEGER, suffix TEXT, content_type TEXT,
        created TEXT, starred TEXT, hidden INTEGER NOT NULL DEFAULT 0, synced_at INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES ('s', 'a', 'T', 'X', 'art', 'p', 1)`,
    );
    applySchema(db);
    db.run(`UPDATE library_songs SET valence = 0.3, mood = 'relaxed' WHERE id = 's'`);
    const row = db
      .query<{ valence: number; mood: string }, []>(
        `SELECT valence, mood FROM library_songs WHERE id = 's'`,
      )
      .get();
    expect(row?.valence).toBeCloseTo(0.3);
    expect(row?.mood).toBe('relaxed');
  });
});

describe('applySchema — landing backfill', () => {
  it('lands every pre-existing song exactly once and never re-lands later rows', () => {
    const db = new Database(':memory:');
    // A legacy library (no landed_at column) with one existing song.
    db.run(`
      CREATE TABLE library_songs (
        id TEXT PRIMARY KEY, album_id TEXT NOT NULL, title TEXT NOT NULL, artist TEXT NOT NULL,
        artist_id TEXT NOT NULL, duration INTEGER NOT NULL DEFAULT 0, genre TEXT, path TEXT NOT NULL,
        hidden INTEGER NOT NULL DEFAULT 0, synced_at INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES ('old', 'a', 'T', 'X', 'art', 'p', 1)`,
    );

    applySchema(db);
    // The pre-existing song is landed (not retroactively quarantined).
    expect(landed(db, 'old')).not.toBeNull();
    // The backfill marker is set so it won't run again.
    expect(
      db.query(`SELECT 1 FROM library_sync_state WHERE key = 'landing_backfill_v1'`).get(),
    ).not.toBeNull();

    // A fresh download arrives quarantined…
    db.run(
      `INSERT INTO library_songs (id, album_id, title, artist, artist_id, path, synced_at)
       VALUES ('new', 'a', 'T2', 'X', 'art', 'p2', 1)`,
    );
    expect(landed(db, 'new')).toBeNull();

    // …and a second applySchema (a restart) must NOT land the in-flight download.
    applySchema(db);
    expect(landed(db, 'new')).toBeNull();
  });
});

function landed(db: Database, id: string): number | null {
  return (
    db
      .query<{ landed_at: number | null }, [string]>(
        'SELECT landed_at FROM library_songs WHERE id = ?',
      )
      .get(id)?.landed_at ?? null
  );
}

describe('addColumnIfMissing (#275)', () => {
  function seed(): Database {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE t (id TEXT PRIMARY KEY)`);
    return db;
  }

  it('adds a missing column and reports that it did', () => {
    const db = seed();
    expect(addColumnIfMissing(db, 't', 'note', 'TEXT')).toBe(true);
    const cols = (db.query(`PRAGMA table_info(t)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('note');
  });

  it('is a no-op on an existing column, so boots stay idempotent', () => {
    const db = seed();
    addColumnIfMissing(db, 't', 'note', 'TEXT');
    db.run(`INSERT INTO t (id, note) VALUES ('a', 'kept')`);

    expect(addColumnIfMissing(db, 't', 'note', 'TEXT')).toBe(false);
    // The second call must not have rebuilt or cleared anything.
    expect(db.query(`SELECT note FROM t WHERE id = 'a'`).get()).toEqual({ note: 'kept' });
  });

  /**
   * The behaviour change worth having. The `try { ALTER } catch {}` this
   * replaced swallowed a malformed declaration exactly as silently as an
   * already-applied column, so a real migration bug surfaced much later as a
   * mysteriously missing column.
   */
  it('throws on a malformed declaration instead of swallowing it', () => {
    const db = seed();
    expect(() => addColumnIfMissing(db, 't', 'bad', 'NOT_A_TYPE DEFAULT )(')).toThrow();
    // And the bogus column really is absent, rather than half-created.
    const cols = (db.query(`PRAGMA table_info(t)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('bad');
  });

  it('throws on an unknown table rather than silently skipping the migration', () => {
    const db = seed();
    expect(() => addColumnIfMissing(db, 'no_such_table', 'x', 'TEXT')).toThrow();
  });
});

describe('applySchema — idempotency (the whole contract)', () => {
  it('is a no-op when run twice, preserving rows', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, synced_at)
       VALUES ('al', 'Album', 'Artist', 'art', 1, 0, 1)`,
    );

    expect(() => applySchema(db)).not.toThrow();
    expect(db.query(`SELECT name FROM library_albums WHERE id = 'al'`).get()).toEqual({
      name: 'Album',
    });
  });

  it('produces an identical column set on the second run', () => {
    const once = new Database(':memory:');
    applySchema(once);
    const twice = new Database(':memory:');
    applySchema(twice);
    applySchema(twice);

    const cols = (db: Database, t: string) =>
      (db.query(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>).map((c) => c.name);
    for (const t of ['library_songs', 'library_albums', 'user_settings']) {
      expect(cols(twice, t)).toEqual(cols(once, t));
    }
  });
});
