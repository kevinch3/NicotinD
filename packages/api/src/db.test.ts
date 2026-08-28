import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PROCESSING_TASK_IDS } from '@nicotind/core';
import {
  SCHEMA_VERSION,
  addColumnIfMissing,
  applySchema,
  mayCarryLegacyShape,
  readSchemaVersion,
} from './db.js';

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

describe('applySchema — users.last_seen_at migration', () => {
  function cols(db: Database): string[] {
    return (db.query('PRAGMA table_info(users)').all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
  }

  it('adds the column to a legacy users table without inventing a value', () => {
    const db = new Database(':memory:');
    // A users table from before this column existed.
    db.run(`
      CREATE TABLE users (
        id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    db.run("INSERT INTO users (id, username, password_hash) VALUES ('u1', 'alice', 'x')");
    expect(cols(db)).not.toContain('last_seen_at');

    applySchema(db);

    expect(cols(db)).toContain('last_seen_at');
    // Deliberately NOT backfilled from created_at — "joined" is not "last seen",
    // and there is no historical source for it (presence was in-memory only).
    expect(
      db
        .query<{ last_seen_at: number | null }, [string]>(
          'SELECT last_seen_at FROM users WHERE id = ?',
        )
        .get('u1')?.last_seen_at ?? null,
    ).toBeNull();
  });

  it('is idempotent across restarts and preserves a stamped value', () => {
    const db = new Database(':memory:');
    applySchema(db);
    db.run(
      "INSERT INTO users (id, username, password_hash, last_seen_at) VALUES ('u1', 'alice', 'x', 4242)",
    );

    applySchema(db);

    expect(
      db
        .query<{ last_seen_at: number | null }, [string]>(
          'SELECT last_seen_at FROM users WHERE id = ?',
        )
        .get('u1')?.last_seen_at,
    ).toBe(4242);
  });
});

describe('applySchema — hold-for-review bootstrap exemption (#417)', () => {
  it('arms the marker on a database that already has a landed song', () => {
    const db = new Database(':memory:');
    // A legacy library (no landed_at column) with one existing song — mirrors
    // the landing-backfill test above, since that backfill is what produces
    // the landed row this arming condition looks for.
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

    expect(
      db.query(`SELECT 1 FROM library_sync_state WHERE key = 'review_hold_armed_v1'`).get(),
    ).not.toBeNull();
  });

  it('does not arm the marker on a fresh, empty database', () => {
    const db = new Database(':memory:');
    applySchema(db);

    expect(
      db.query(`SELECT 1 FROM library_sync_state WHERE key = 'review_hold_armed_v1'`).get(),
    ).toBeNull();
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

describe('applySchema — schema version (issue #612)', () => {
  it('stamps the current version on a fresh database', () => {
    const db = new Database(':memory:');
    expect(readSchemaVersion(db)).toBe(0);
    applySchema(db);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('stamps a populated database that predates versioning', () => {
    // Every database in the field today is at 0 — the marker did not exist.
    const db = new Database(':memory:');
    db.run(`CREATE TABLE users (id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL,
            password_hash TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
            created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
    db.run(`INSERT INTO users (id, username, password_hash) VALUES ('u', 'kev', 'h')`);

    applySchema(db);

    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(db.query(`SELECT username FROM users WHERE id = 'u'`).get()).toEqual({
      username: 'kev',
    });
  });

  it('holds the version steady across repeated boots', () => {
    const db = new Database(':memory:');
    applySchema(db);
    applySchema(db);
    applySchema(db);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  it('never lowers a stamp written by a newer binary', () => {
    // Rolling back to a previous image tag is the documented recovery path, so
    // an older binary WILL meet a newer database. It still applies its own
    // schema, but writing its lower number back would erase the record that the
    // newer run-once migrations already ran — and re-upgrading would replay
    // exactly the steps the version exists to guard.
    const db = new Database(':memory:');
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

    expect(() => applySchema(db)).not.toThrow();

    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION + 1);
    // ...and it still did its job: the schema is present.
    expect(
      db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get(),
    ).toEqual({ name: 'users' });
  });
});

describe('applySchema — atomicity (issue #612)', () => {
  /**
   * A view standing where a table belongs makes `CREATE TABLE IF NOT EXISTS`
   * no-op and the index that follows it fail — a genuine mid-body error, ~1,400
   * lines after the first statement. Any surviving object proves the migration
   * is not atomic.
   */
  const injectFailure = (db: Database) => db.run(`CREATE VIEW play_events AS SELECT 1 AS x`);

  it('rolls back every earlier statement when a later one fails', () => {
    const db = new Database(':memory:');
    injectFailure(db);

    expect(() => applySchema(db)).toThrow();

    // `users` is the FIRST table the schema creates. Without a transaction it
    // survives a failure 1,400 lines later, and the database is left in a state
    // no version marker describes.
    expect(
      db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get(),
    ).toBeNull();
  });

  it('does not stamp a version for a migration that failed', () => {
    // The stamp must not be able to claim a migration that did not land — it is
    // written inside the same transaction precisely so it cannot.
    const db = new Database(':memory:');
    injectFailure(db);

    expect(() => applySchema(db)).toThrow();

    expect(readSchemaVersion(db)).toBe(0);
  });

  it('rolls back a destructive table rebuild that was already half-done', () => {
    // The migration this most has to protect: the pre-'ep' library_albums
    // rebuild is RENAME -> CREATE -> copy -> DROP. Un-transactioned, a failure
    // anywhere after it strands the rows in library_albums_old, and the NEXT
    // boot recreates an empty library_albums and skips the migration, because a
    // fresh table no longer carries the legacy marker it looks for.
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE library_albums (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, artist TEXT NOT NULL,
        artist_id TEXT NOT NULL, cover_art TEXT, song_count INTEGER NOT NULL DEFAULT 0,
        duration INTEGER NOT NULL DEFAULT 0, year INTEGER, genre TEXT, created TEXT,
        starred TEXT,
        classification TEXT NOT NULL DEFAULT 'unknown'
            CHECK (classification IN ('album','single','compilation','unknown')),
        hidden INTEGER NOT NULL DEFAULT 0, manual_override INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
       VALUES ('keep', 'Discovery', 'Daft Punk', 'art', 14, 0, 'album', 1)`,
    );
    injectFailure(db);

    expect(() => applySchema(db)).toThrow();

    // The rebuild is fully undone: no orphaned _old table, the row is still
    // reachable under its real name, and the legacy CHECK is back in place —
    // so the next boot still recognises this database as needing the migration.
    expect(
      db.query(`SELECT name FROM sqlite_master WHERE name='library_albums_old'`).get(),
    ).toBeNull();
    expect(db.query(`SELECT name FROM library_albums WHERE id='keep'`).get()).toEqual({
      name: 'Discovery',
    });
    const sql = db
      .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name='library_albums'`)
      .get()!.sql;
    expect(sql).not.toContain("'ep'");
  });
});

/** The legacy pre-native-playlists shape: no `description` column. */
function legacyPlaylists(db: Database): void {
  db.run(`CREATE TABLE playlists (id TEXT PRIMARY KEY, user_id TEXT NOT NULL,
          name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)`);
  db.run(`CREATE TABLE playlist_songs (playlist_id TEXT NOT NULL, song_id TEXT NOT NULL,
          position INTEGER NOT NULL, PRIMARY KEY (playlist_id, song_id))`);
  db.run(`INSERT INTO playlists VALUES ('p1', 'u1', 'Roadtrip', 1, 1)`);
  db.run(`INSERT INTO playlist_songs VALUES ('p1', 's1', 0)`);
}

describe('mayCarryLegacyShape', () => {
  it('is true only for a database this has never stamped', () => {
    expect(mayCarryLegacyShape(0)).toBe(true);
    expect(mayCarryLegacyShape(1)).toBe(false);
    expect(mayCarryLegacyShape(SCHEMA_VERSION)).toBe(false);
  });
});

describe('applySchema — destructive migrations are version-gated (issue #612)', () => {
  it('still migrates a legacy database that was never stamped', () => {
    // The gate must not strand a genuinely old database.
    const db = new Database(':memory:');
    legacyPlaylists(db);
    expect(readSchemaVersion(db)).toBe(0);

    applySchema(db);

    // The legacy tables really were dropped and rebuilt in the modern shape.
    expect(db.query(`SELECT id FROM playlists WHERE id = 'p1'`).get()).toBeNull();
    const cols = (db.query(`PRAGMA table_info(playlists)`).all() as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('description');
  });

  it('never drops playlists again once the database is stamped', () => {
    // THE point of the gate. `DROP TABLE playlists` fires on nothing more than
    // the word "description" being absent from a schema string, and it was
    // armed on every boot forever. Prod carries 67 playlists / 2,629
    // playlist_songs rows behind that check.
    //
    // A stamped database cannot legitimately hold a legacy shape (the stamp is
    // written only after the migration ran), so gating trades "repair an
    // impossible state" for "never destroy user data on a substring match".
    const db = new Database(':memory:');
    legacyPlaylists(db);
    db.run(`PRAGMA user_version = 1`);

    applySchema(db);

    expect(db.query(`SELECT name FROM playlists WHERE id = 'p1'`).get()).toEqual({
      name: 'Roadtrip',
    });
    expect(db.query(`SELECT song_id FROM playlist_songs WHERE playlist_id = 'p1'`).get()).toEqual({
      song_id: 's1',
    });
  });

  it('never rebuilds library_albums again once the database is stamped', () => {
    const db = new Database(':memory:');
    db.run(`
      CREATE TABLE library_albums (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, artist TEXT NOT NULL,
        artist_id TEXT NOT NULL, cover_art TEXT, song_count INTEGER NOT NULL DEFAULT 0,
        duration INTEGER NOT NULL DEFAULT 0, year INTEGER, genre TEXT, created TEXT,
        starred TEXT,
        classification TEXT NOT NULL DEFAULT 'unknown'
            CHECK (classification IN ('album','single','compilation','unknown')),
        hidden INTEGER NOT NULL DEFAULT 0, manual_override INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL
      )
    `);
    db.run(`PRAGMA user_version = 1`);

    applySchema(db);

    // Untouched: the pre-'ep' CHECK is still there, because the rebuild is now
    // unreachable rather than merely no-op.
    const sql = db
      .query<{ sql: string }, []>(`SELECT sql FROM sqlite_master WHERE name='library_albums'`)
      .get()!.sql;
    expect(sql).not.toContain("'ep'");
  });

  it('stops re-dropping the dead tombstones table once stamped', () => {
    // Not heuristic like the other four, but still an unconditional DROP that
    // ran on every boot forever — so a future table reusing the name would be
    // silently destroyed. Retired by the same gate.
    const db = new Database(':memory:');
    db.run(`CREATE TABLE library_album_tombstones (id TEXT PRIMARY KEY)`);
    db.run(`PRAGMA user_version = 1`);

    applySchema(db);

    expect(
      db.query(`SELECT name FROM sqlite_master WHERE name='library_album_tombstones'`).get(),
    ).toEqual({ name: 'library_album_tombstones' });
  });

  it('still drops the dead tombstones table on an unstamped database', () => {
    const db = new Database(':memory:');
    db.run(`CREATE TABLE library_album_tombstones (id TEXT PRIMARY KEY)`);

    applySchema(db);

    expect(
      db.query(`SELECT name FROM sqlite_master WHERE name='library_album_tombstones'`).get(),
    ).toBeNull();
  });
});

describe('applySchema — migrations under foreign_keys=ON (issue #612)', () => {
  /**
   * `initDatabase` runs `PRAGMA foreign_keys=ON`; a bare `:memory:` database
   * defaults to OFF. Every migration test above therefore exercised a
   * configuration production does not run. That matters here specifically:
   * under FKs ON, `ALTER TABLE x RENAME TO x_old` REPOINTS a child table's
   * foreign key at `x_old`, so the `DROP TABLE x_old` that follows can cascade
   * the child's rows away.
   */
  const prodConnection = () => {
    const db = new Database(':memory:');
    db.run('PRAGMA foreign_keys=ON');
    return db;
  };

  it('relaxes the acquire_jobs CHECK without losing rows or orphaning _old', () => {
    const db = prodConnection();
    db.run(`CREATE TABLE acquire_jobs (
      id TEXT PRIMARY KEY, backend TEXT NOT NULL CHECK (backend IN ('ytdlp','spotdl')),
      url TEXT NOT NULL, label TEXT, state TEXT NOT NULL DEFAULT 'queued',
      progress TEXT, error TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j1','ytdlp','http://x')`);

    applySchema(db);

    expect(db.query(`SELECT backend FROM acquire_jobs WHERE id='j1'`).get()).toEqual({
      backend: 'ytdlp',
    });
    expect(
      db.query(`SELECT name FROM sqlite_master WHERE name='acquire_jobs_old'`).get(),
    ).toBeNull();
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });

  it('leaves no foreign-key violations after the library_albums rebuild', () => {
    const db = prodConnection();
    db.run(`
      CREATE TABLE library_albums (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, artist TEXT NOT NULL,
        artist_id TEXT NOT NULL, cover_art TEXT, song_count INTEGER NOT NULL DEFAULT 0,
        duration INTEGER NOT NULL DEFAULT 0, year INTEGER, genre TEXT, created TEXT,
        starred TEXT,
        classification TEXT NOT NULL DEFAULT 'unknown'
            CHECK (classification IN ('album','single','compilation','unknown')),
        hidden INTEGER NOT NULL DEFAULT 0, manual_override INTEGER NOT NULL DEFAULT 0,
        synced_at INTEGER NOT NULL
      )
    `);
    db.run(
      `INSERT INTO library_albums (id, name, artist, artist_id, song_count, duration, classification, synced_at)
       VALUES ('keep', 'Discovery', 'Daft Punk', 'art', 14, 0, 'album', 1)`,
    );

    applySchema(db);

    expect(db.query(`SELECT name FROM library_albums WHERE id='keep'`).get()).toEqual({
      name: 'Discovery',
    });
    expect(
      db.query(`SELECT name FROM sqlite_master WHERE name='library_albums_old'`).get(),
    ).toBeNull();
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
  });

  it('documents why acquire_job_tracks must be created AFTER the rebuild', () => {
    // A characterization test, not an aspiration. `acquire_job_tracks` holds a
    // foreign key to `acquire_jobs`, and the rebuild renames the parent away.
    // Under FKs ON, SQLite repoints the child's key at `acquire_jobs_old`, so
    // the `DROP TABLE acquire_jobs_old` that follows cascades the child's rows
    // out of existence — 1 row survives with FKs OFF, 0 with them ON.
    //
    // This is unreachable today ONLY because applySchema creates
    // `acquire_job_tracks` further down the same function, so it cannot exist
    // when the rebuild runs. That ordering is load-bearing and nothing else
    // enforces it. If a future change moves the child table's creation above
    // the rebuild — or adds another child of `acquire_jobs` earlier — this test
    // is the thing that says what breaks.
    const db = prodConnection();
    db.run(`CREATE TABLE acquire_jobs (
      id TEXT PRIMARY KEY, backend TEXT NOT NULL CHECK (backend IN ('ytdlp','spotdl')),
      url TEXT NOT NULL, label TEXT, state TEXT NOT NULL DEFAULT 'queued',
      progress TEXT, error TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch()))`);
    db.run(`CREATE TABLE acquire_job_tracks (
      job_id TEXT NOT NULL REFERENCES acquire_jobs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL, title TEXT NOT NULL, status TEXT NOT NULL,
      path TEXT NOT NULL, PRIMARY KEY (job_id, position))`);
    db.run(`INSERT INTO acquire_jobs (id, backend, url) VALUES ('j1','ytdlp','http://x')`);
    db.run(`INSERT INTO acquire_job_tracks VALUES ('j1', 0, 'Track', 'done', 'a.mp3')`);

    applySchema(db);

    // The parent survives the rebuild; the child does not.
    expect(db.query(`SELECT id FROM acquire_jobs WHERE id='j1'`).get()).toEqual({ id: 'j1' });
    expect(db.query<{ c: number }, []>(`SELECT COUNT(*) c FROM acquire_job_tracks`).get()).toEqual({
      c: 0,
    });
  });

  it('applies a whole fresh schema cleanly with foreign keys enforced', () => {
    const db = prodConnection();
    expect(() => applySchema(db)).not.toThrow();
    expect(db.query(`PRAGMA foreign_key_check`).all()).toEqual([]);
    expect(readSchemaVersion(db)).toBe(SCHEMA_VERSION);
  });
});

describe('applySchema — onBeforeMigrate (issue #612)', () => {
  it('fires when the version is about to advance', () => {
    const db = new Database(':memory:');
    const seen: Array<[number, number]> = [];

    applySchema(db, { onBeforeMigrate: (f, t) => seen.push([f, t]) });

    expect(seen).toEqual([[0, SCHEMA_VERSION]]);
  });

  it('does NOT fire on an ordinary boot where the version is current', () => {
    // The cost of a snapshot lands only when the schema actually changes. On a
    // stamped host every restart would otherwise copy the whole database — 170
    // MB on the reference deployment — to protect a migration that will not run.
    const db = new Database(':memory:');
    applySchema(db);
    let calls = 0;

    applySchema(db, { onBeforeMigrate: () => calls++ });

    expect(calls).toBe(0);
  });

  it('aborts the whole migration when the hook throws', () => {
    // A snapshot that could not be taken must stop the migration, not be
    // shrugged off — proceeding is the one outcome the hook exists to prevent.
    const db = new Database(':memory:');

    expect(() =>
      applySchema(db, {
        onBeforeMigrate: () => {
          throw new Error('disk full');
        },
      }),
    ).toThrow('disk full');

    expect(readSchemaVersion(db)).toBe(0);
    expect(
      db.query(`SELECT name FROM sqlite_master WHERE type='table' AND name='users'`).get(),
    ).toBeNull();
  });

  it('runs outside the transaction, so VACUUM INTO is legal inside it', () => {
    // SQLite refuses "VACUUM INTO" from within a transaction, and taking a
    // snapshot is the entire reason this hook exists — so if it ever moves
    // inside `db.transaction()`, this fails with exactly that error.
    const dir = mkdtempSync(join(tmpdir(), 'nicotind-hook-'));
    try {
      const db = new Database(join(dir, 'nicotind.db'), { create: true });
      db.run('PRAGMA journal_mode=WAL');
      let snapshotted = false;

      applySchema(db, {
        onBeforeMigrate: () => {
          db.run('VACUUM INTO ?', [join(dir, 'snap.db')]);
          snapshotted = true;
        },
      });

      expect(snapshotted).toBe(true);
      expect(existsSync(join(dir, 'snap.db'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('applySchema — retired-task ledger sweep (issue #779)', () => {
  function seedFailure(db: Database, songId: string, task: string) {
    db.run(
      `INSERT INTO library_song_analysis_failures (song_id, task, fail_count, last_error, last_attempt)
       VALUES (?, ?, 3, 'x', 1)`,
      [songId, task],
    );
  }
  const tasksIn = (db: Database) =>
    db
      .query<{ task: string }, []>(
        'SELECT DISTINCT task FROM library_song_analysis_failures ORDER BY task',
      )
      .all()
      .map((r) => r.task);

  it('sweeps rows for a task that no longer exists', () => {
    const db = new Database(':memory:');
    applySchema(db);
    seedFailure(db, 's1', 'licence');
    seedFailure(db, 's2', 'genre');
    applySchema(db);
    expect(tasksIn(db)).toEqual(['genre']);
  });

  // Unmarkered on purpose: the sweep derives its denominator from the live task
  // registry, so a task retired later is swept without a new migration.
  it('leaves every live task alone', () => {
    const db = new Database(':memory:');
    applySchema(db);
    for (const id of PROCESSING_TASK_IDS) seedFailure(db, `s-${id}`, id);
    applySchema(db);
    expect(tasksIn(db).sort()).toEqual([...PROCESSING_TASK_IDS].sort());
  });

  it('is a no-op on a ledger that holds only live tasks', () => {
    const db = new Database(':memory:');
    applySchema(db);
    seedFailure(db, 's1', 'genre-audio');
    const before = db
      .query<{ c: number }, []>('SELECT COUNT(*) c FROM library_song_analysis_failures')
      .get()!.c;
    applySchema(db);
    expect(
      db.query<{ c: number }, []>('SELECT COUNT(*) c FROM library_song_analysis_failures').get()!.c,
    ).toBe(before);
  });
});
