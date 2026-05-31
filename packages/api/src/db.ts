import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';

let db: Database;

export function initDatabase(dataDir: string): Database {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, 'nicotind.db');
  db = new Database(dbPath, { create: true });

  db.run('PRAGMA journal_mode=WAL');
  db.run('PRAGMA foreign_keys=ON');
  applySchema(db);
  return db;
}

/**
 * Applies the canonical schema to a database. Extracted so tests can build
 * in-memory databases without the disk-side `initDatabase` setup.
 */
export function applySchema(db: Database): void {
  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS user_settings (
      user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      theme TEXT NOT NULL DEFAULT 'system',
      default_min_bitrate INTEGER,
      default_file_types TEXT
    )
  `);

  // Add status column to existing users table (safe if column already exists)
  try {
    db.run(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  } catch {
    // Column already exists — ignore
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS hidden_transfers (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // Tracks auto-retry attempts for failed slskd transfers. Keyed the same way as
  // the download watcher's completion set: `${username}::${filename}`. When
  // attempts exhaust, gave_up=1 freezes it (UI shows Error; cross-peer fallback
  // and manual retry can still act on it).
  db.run(`
    CREATE TABLE IF NOT EXISTS transfer_retries (
      transfer_key TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      filename TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_attempt INTEGER,
      gave_up INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Album download jobs from the Lidarr hunt. Persists the canonical tracklist
  // and the ranked alternate folder candidates so the cross-peer fallback layer
  // can pull tracks the primary peer failed to deliver from a different peer.
  db.run(`
    CREATE TABLE IF NOT EXISTS album_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lidarr_album_id INTEGER,
      username TEXT NOT NULL,
      directory TEXT NOT NULL,
      canonical_tracks_json TEXT NOT NULL,
      alternates_json TEXT NOT NULL,
      fallback_attempts INTEGER NOT NULL DEFAULT 0,
      state TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL
    )
  `);

  db.run(`CREATE INDEX IF NOT EXISTS idx_album_jobs_state ON album_jobs (state)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS completed_downloads (
      transfer_key TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      directory TEXT NOT NULL,
      filename TEXT NOT NULL,
      relative_path TEXT,
      basename TEXT NOT NULL,
      completed_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_completed_downloads_completed_at
    ON completed_downloads (completed_at DESC)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_completed_downloads_relative_path
    ON completed_downloads (relative_path)
  `);

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_completed_downloads_basename_completed_at
    ON completed_downloads (basename, completed_at DESC)
  `);

  try {
    db.run(`ALTER TABLE completed_downloads ADD COLUMN navidrome_id TEXT`);
  } catch {
    // Column already exists — ignore
  }

  db.run(`
    CREATE INDEX IF NOT EXISTS idx_completed_downloads_navidrome_id
    ON completed_downloads (navidrome_id)
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS playlist_visibility (
      playlist_id TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      visibility  TEXT NOT NULL DEFAULT 'personal'
                       CHECK (visibility IN ('personal', 'global'))
    )
  `);

  // visibility column is retained but unused; all playlists are shared.
  try { db.run(`ALTER TABLE playlist_visibility ADD COLUMN created_by TEXT REFERENCES users(id)`); } catch { /* column exists */ }
  try { db.run(`ALTER TABLE playlist_visibility ADD COLUMN created_at TEXT`); } catch { /* column exists */ }
  try { db.run(`ALTER TABLE playlist_visibility ADD COLUMN modified_by TEXT REFERENCES users(id)`); } catch { /* column exists */ }
  try { db.run(`ALTER TABLE playlist_visibility ADD COLUMN modified_at TEXT`); } catch { /* column exists */ }

  try {
    db.run(`
      UPDATE playlist_visibility
      SET created_by   = owner_id,
          created_at   = datetime('now'),
          modified_by  = owner_id,
          modified_at  = datetime('now'),
          visibility   = 'global'
      WHERE created_at IS NULL
    `);
  } catch { /* columns not present on first boot; UPDATE runs harmlessly next time */ }

  db.run(`CREATE INDEX IF NOT EXISTS idx_playlist_visibility_created_by ON playlist_visibility(created_by)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS share_tokens (
      token             TEXT    PRIMARY KEY,
      resource_type     TEXT    NOT NULL CHECK (resource_type IN ('playlist', 'album')),
      resource_id       TEXT    NOT NULL,
      created_by        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at        INTEGER NOT NULL,
      first_accessed_at INTEGER,
      expires_at        INTEGER
    )
  `);

  // Canonical library tables — populated by NavidromeSyncer after each scan.
  // The UI reads exclusively from these (not from Navidrome directly), so we
  // can hide, classify, and group independently of what Navidrome thinks.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_albums (
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_hidden ON library_albums(hidden)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_classification ON library_albums(classification)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_artist_id ON library_albums(artist_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_created ON library_albums(created DESC)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_name ON library_albums(name COLLATE NOCASE)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS library_songs (
      id            TEXT PRIMARY KEY,
      album_id      TEXT NOT NULL,
      title         TEXT NOT NULL,
      artist        TEXT NOT NULL,
      artist_id     TEXT NOT NULL,
      track         INTEGER,
      disc          INTEGER,
      duration      INTEGER NOT NULL DEFAULT 0,
      year          INTEGER,
      genre         TEXT,
      cover_art     TEXT,
      path          TEXT NOT NULL,
      size          INTEGER,
      bit_rate      INTEGER,
      suffix        TEXT,
      content_type  TEXT,
      created       TEXT,
      starred       TEXT,
      hidden        INTEGER NOT NULL DEFAULT 0,
      synced_at     INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_album_id ON library_songs(album_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_artist_id ON library_songs(artist_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_path ON library_songs(path)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_genre ON library_songs(genre)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_hidden ON library_songs(hidden)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS library_artists (
      id              TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      album_count     INTEGER NOT NULL DEFAULT 0,
      cover_art       TEXT,
      starred         TEXT,
      hidden          INTEGER NOT NULL DEFAULT 0,
      manual_override INTEGER NOT NULL DEFAULT 0,
      synced_at       INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_artists_name ON library_artists(name COLLATE NOCASE)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_artists_hidden ON library_artists(hidden)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS library_genres (
      name        TEXT PRIMARY KEY,
      song_count  INTEGER NOT NULL DEFAULT 0,
      album_count INTEGER NOT NULL DEFAULT 0,
      synced_at   INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS library_sync_state (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS artist_discography_links (
      artist_id  TEXT NOT NULL,
      lidarr_id  INTEGER,
      mbid       TEXT,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (artist_id)
    )
  `);

  // Audit trail written by normalize-library.ts and future automation.
  // navidrome_id is null until NavidromeSyncer backfills it via path join.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_song_provenance (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      song_path    TEXT NOT NULL,
      navidrome_id TEXT,
      action       TEXT NOT NULL,
      detail       TEXT NOT NULL,
      applied_at   INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_provenance_path ON library_song_provenance(song_path)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_provenance_navidrome_id ON library_song_provenance(navidrome_id)`);
}

export function getDatabase(): Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase first.');
  return db;
}
