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

  // Generic key/value app settings (JSON values). Used for streaming/transcode
  // preferences; not user-scoped.
  db.run(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

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

  // The cross-peer fallback recovers tracks the *chosen folder* promised but the
  // peer failed to deliver. Its recovery target is this manifest (the files the
  // user actually selected) — NOT the canonical Lidarr tracklist, which can be a
  // bloated deluxe/special edition whose bonus/live cuts no single Soulseek
  // folder contains, leaving the fallback permanently "incomplete" and dumping
  // duplicate rips into the album folder. Nullable for pre-existing rows.
  try {
    db.run(`ALTER TABLE album_jobs ADD COLUMN target_files_json TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Artist name, captured at hunt-download time. Lets the cross-peer fallback
  // fire a *fresh* slskd search ("<artist> <track>") for tracks no recorded
  // alternate can supply, instead of giving up the moment the stale alternates
  // are exhausted. Nullable for pre-existing rows (those skip the fresh-search
  // step and behave exactly as before).
  try {
    db.run(`ALTER TABLE album_jobs ADD COLUMN artist_name TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Album title, for the "incomplete albums" UI surface (so a user can see which
  // hunts ended exhausted and re-trigger them). Nullable for pre-existing rows.
  try {
    db.run(`ALTER TABLE album_jobs ADD COLUMN album_title TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Auto-retry of exhausted jobs: how many times a job has been revived for
  // another fallback wave, and when it was last revived (cooldown gate). Lets
  // the fallback periodically re-attempt albums whose peers were offline at
  // hunt time without churning — bounded by exhaustedMaxRevives + cooldown.
  try {
    db.run(`ALTER TABLE album_jobs ADD COLUMN revive_count INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run(`ALTER TABLE album_jobs ADD COLUMN last_revived_at INTEGER`);
  } catch {
    // Column already exists — ignore
  }

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

  // URL-based acquisition jobs (yt-dlp / spotdl). Separate from album_jobs which
  // is tightly coupled to Lidarr album IDs. Each row represents one submitted URL
  // (a single track, playlist, or album page) and tracks spawned-process state.
  db.run(`
    CREATE TABLE IF NOT EXISTS acquire_jobs (
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
  db.run(`CREATE INDEX IF NOT EXISTS idx_acquire_jobs_state ON acquire_jobs (state)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_acquire_jobs_created_at ON acquire_jobs (created_at DESC)`);

  // Watchlist: albums the user asked to auto-acquire. A background poller
  // (WatchlistService) periodically hunts each `watching` row and, when a
  // confidently-complete folder is found, fires the normal album-hunt download
  // flow (reusing its idempotency guards) and flips the row to `acquired`.
  // foreign_album_id (MusicBrainz release-group) is the natural unique key; it
  // can be null for rows added without catalog metadata, so NULLs may repeat.
  db.run(`
    CREATE TABLE IF NOT EXISTS watchlist (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      foreign_album_id TEXT UNIQUE,
      artist_mbid      TEXT,
      artist_name      TEXT NOT NULL,
      album_title      TEXT NOT NULL,
      lidarr_album_id  INTEGER,
      state            TEXT NOT NULL DEFAULT 'watching'
                           CHECK (state IN ('watching', 'acquired', 'failed')),
      last_checked_at  INTEGER,
      last_error       TEXT,
      created_at       INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_watchlist_state ON watchlist (state)`);

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

  // Canonical library tables — populated by the native LibraryScanner. The UI
  // reads exclusively from these; the scanner mints stable ids and groups
  // editions at scan time, so hide/classify/group all happen here.
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
                          CHECK (classification IN ('album','ep','single','compilation','unknown')),
      hidden          INTEGER NOT NULL DEFAULT 0,
      manual_override INTEGER NOT NULL DEFAULT 0,
      synced_at       INTEGER NOT NULL
    )
  `);

  // Migration: widen `classification` to allow 'ep' (the release-type model).
  // SQLite can't ALTER a CHECK constraint, so when an old DB's table still has
  // the pre-'ep' constraint we rebuild it, preserving every column (incl. the
  // curation columns hidden/classification/manual_override/starred). Idempotent:
  // skipped once the constraint already permits 'ep'. Runs before the index
  // statements below so they re-create indexes on the rebuilt table.
  const albumsSql =
    db
      .query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='library_albums'`,
      )
      .get()?.sql ?? '';
  if (albumsSql && !albumsSql.includes("'ep'")) {
    db.transaction(() => {
      db.run(`ALTER TABLE library_albums RENAME TO library_albums_old`);
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
                              CHECK (classification IN ('album','ep','single','compilation','unknown')),
          hidden          INTEGER NOT NULL DEFAULT 0,
          manual_override INTEGER NOT NULL DEFAULT 0,
          synced_at       INTEGER NOT NULL
        )
      `);
      db.run(`INSERT INTO library_albums SELECT * FROM library_albums_old`);
      db.run(`DROP TABLE library_albums_old`);
    })();
  }

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

  // Canonical artwork (Lidarr/MusicBrainz cover/poster URLs), keyed on the same
  // deterministic ids the scanner mints (albumId / artistId). Kept in its own
  // table — NOT on library_albums/library_artists — so it (a) survives full
  // rescans and prunes untouched, and (b) can be written at hunt time before the
  // album has even been scanned onto disk. The cover route prefers this over the
  // file's embedded/folder art so the app matches the hunt tool, and serves real
  // artist posters (which on-disk audio files never carry).
  db.run(`
    CREATE TABLE IF NOT EXISTS library_artwork (
      id         TEXT PRIMARY KEY,
      kind       TEXT NOT NULL CHECK (kind IN ('album','artist')),
      cover_url  TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Authoritative release type (album / ep / single / compilation) from
  // Lidarr/MusicBrainz, keyed on the scanner's deterministic albumId — same
  // side-table pattern as library_artwork: survives full rescans/prunes and can
  // be written at ingest time before the album exists on disk. The curator
  // prefers this over its track-count heuristic when classifying.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_release_meta (
      album_id        TEXT PRIMARY KEY,
      album_type      TEXT NOT NULL CHECK (album_type IN ('album','ep','single','compilation')),
      canonical_title TEXT,
      source          TEXT,
      updated_at      INTEGER NOT NULL
    )
  `);

  // Native per-user playlists (re-added after the Navidrome removal). Playlists
  // reference songs by the scanner's stable songId; reads JOIN library_songs and
  // drop rows whose song no longer exists (file moved → id changed), so a
  // playlist degrades gracefully rather than showing dead entries.
  db.run(`
    CREATE TABLE IF NOT EXISTS playlists (
      id          TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER NOT NULL,
      modified_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id)`);
  db.run(`
    CREATE TABLE IF NOT EXISTS playlist_songs (
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      song_id     TEXT NOT NULL,
      position    INTEGER NOT NULL,
      added_at    INTEGER NOT NULL,
      PRIMARY KEY (playlist_id, song_id)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_playlist_songs_pl ON playlist_songs(playlist_id)`);

  // Legacy table from the Navidrome era (album-deletion tombstones). The native
  // scanner reads disk directly and synchronously, so deletions can't be
  // resurrected and this is no longer used. Kept for backward-compatible
  // migrations; safe to drop in a future cleanup.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_album_tombstones (
      album_id   TEXT PRIMARY KEY,
      name       TEXT,
      artist     TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  // artist lets the syncer suppress a deleted album by group key (artist+title),
  // so a merged album can't resurrect via a surviving sibling fragment.
  try {
    db.run(`ALTER TABLE library_album_tombstones ADD COLUMN artist TEXT`);
  } catch {
    // Column already exists — ignore
  }

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
