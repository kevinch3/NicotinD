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
      default_file_types TEXT,
      welcome_dismissed INTEGER NOT NULL DEFAULT 0
    )
  `);

  // Add status column to existing users table (safe if column already exists)
  try {
    db.run(`ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`);
  } catch {
    // Column already exists — ignore
  }

  // Add welcome_dismissed column to existing user_settings table
  try {
    db.run(`ALTER TABLE user_settings ADD COLUMN welcome_dismissed INTEGER NOT NULL DEFAULT 0`);
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
  try {
    db.run(`ALTER TABLE playlist_visibility ADD COLUMN created_by TEXT REFERENCES users(id)`);
  } catch {
    /* column exists */
  }
  try {
    db.run(`ALTER TABLE playlist_visibility ADD COLUMN created_at TEXT`);
  } catch {
    /* column exists */
  }
  try {
    db.run(`ALTER TABLE playlist_visibility ADD COLUMN modified_by TEXT REFERENCES users(id)`);
  } catch {
    /* column exists */
  }
  try {
    db.run(`ALTER TABLE playlist_visibility ADD COLUMN modified_at TEXT`);
  } catch {
    /* column exists */
  }

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
  } catch {
    /* columns not present on first boot; UPDATE runs harmlessly next time */
  }

  db.run(
    `CREATE INDEX IF NOT EXISTS idx_playlist_visibility_created_by ON playlist_visibility(created_by)`,
  );

  // URL-based acquisition jobs (yt-dlp / spotdl). Separate from album_jobs which
  // is tightly coupled to Lidarr album IDs. Each row represents one submitted URL
  // (a single track, playlist, or album page) and tracks spawned-process state.
  db.run(`
    CREATE TABLE IF NOT EXISTS acquire_jobs (
      id          TEXT PRIMARY KEY,
      backend     TEXT NOT NULL,
      url         TEXT NOT NULL,
      label       TEXT,
      state       TEXT NOT NULL DEFAULT 'queued'
                      CHECK (state IN ('queued', 'running', 'done', 'failed')),
      progress    TEXT,
      error       TEXT,
      created_at  INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  // `backend` was once CHECK (backend IN ('ytdlp','spotdl')); it's now an open
  // acquisition-plugin id. Rebuild legacy tables to drop that constraint.
  const acquireSql = db
    .query<
      { sql: string },
      []
    >(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'acquire_jobs'`)
    .get();
  if (acquireSql?.sql.includes('backend IN')) {
    db.run('ALTER TABLE acquire_jobs RENAME TO acquire_jobs_old');
    db.run(`
      CREATE TABLE acquire_jobs (
        id          TEXT PRIMARY KEY,
        backend     TEXT NOT NULL,
        url         TEXT NOT NULL,
        label       TEXT,
        state       TEXT NOT NULL DEFAULT 'queued'
                        CHECK (state IN ('queued', 'running', 'done', 'failed')),
        progress    TEXT,
        error       TEXT,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
    db.run(
      `INSERT INTO acquire_jobs (id, backend, url, label, state, progress, error, created_at)
       SELECT id, backend, url, label, state, progress, error, created_at FROM acquire_jobs_old`,
    );
    db.run('DROP TABLE acquire_jobs_old');
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_acquire_jobs_state ON acquire_jobs (state)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_acquire_jobs_created_at ON acquire_jobs (created_at DESC)`,
  );
  // Fine-grained pipeline stage + the canonical album dir the job landed in, so
  // the downloads feed can show queued → downloading → organizing → scanning →
  // done and where the files ended up. Added after the original schema shipped.
  try {
    db.run(`ALTER TABLE acquire_jobs ADD COLUMN stage TEXT`);
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run(`ALTER TABLE acquire_jobs ADD COLUMN storage_path TEXT`);
  } catch {
    // Column already exists — ignore
  }

  // Acquisition provenance, keyed on the final on-disk path (== library_songs.path)
  // — the same join the rest of the system already uses. Records HOW (method),
  // WHERE-FROM (source_ref: slskd peer or acquire URL), and WHEN each file was
  // acquired. Written at download time by download-watcher (slskd) and
  // acquire-watcher (URL), and best-effort backfilled for pre-existing rows.
  // Same side-table pattern as library_artwork/library_release_meta: keyed on a
  // stable path/id so it survives full rescans. A file moved by a later rescan
  // changes its path and orphans its row (same fragility as library_songs.id).
  db.run(`
    CREATE TABLE IF NOT EXISTS acquisitions (
      relative_path TEXT PRIMARY KEY,
      method        TEXT NOT NULL,
      source_ref    TEXT,
      stage         TEXT NOT NULL,
      started_at    INTEGER NOT NULL,
      completed_at  INTEGER,
      error         TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_acquisitions_method ON acquisitions (method)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_acquisitions_started ON acquisitions (started_at DESC)`);

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
      .query<
        { sql: string },
        []
      >(`SELECT sql FROM sqlite_master WHERE type='table' AND name='library_albums'`)
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
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_library_albums_classification ON library_albums(classification)`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_artist_id ON library_albums(artist_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_created ON library_albums(created DESC)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_library_albums_name ON library_albums(name COLLATE NOCASE)`,
  );

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
      bpm           INTEGER,
      key           TEXT,
      synced_at     INTEGER NOT NULL
    )
  `);
  // Add bpm to existing library_songs tables (safe if it already exists). Set by
  // tag reads at scan time and by on-demand track analysis.
  try {
    db.run(`ALTER TABLE library_songs ADD COLUMN bpm INTEGER`);
  } catch {
    // Column already exists — ignore
  }
  // Musical key (e.g. "C major" / "A minor"), same additive pattern as bpm — read
  // from tags at scan time, filled by on-demand/windowed key analysis.
  try {
    db.run(`ALTER TABLE library_songs ADD COLUMN key TEXT`);
  } catch {
    // Column already exists — ignore
  }
  // Perceptual audio features. energy/loudness come from ffmpeg ebur128 (works
  // without the analysis sidecar); danceability/valence/acousticness/instrumental/
  // mood come from the Essentia analysis sidecar. Same additive contract as
  // bpm/key: read from file tags at scan time, filled by windowed enrichment,
  // COALESCE-preserved on rescan.
  for (const col of [
    'energy REAL',
    'loudness REAL',
    'danceability REAL',
    'valence REAL',
    'acousticness REAL',
    'instrumental REAL',
    'mood TEXT',
  ]) {
    try {
      db.run(`ALTER TABLE library_songs ADD COLUMN ${col}`);
    } catch {
      // Column already exists — ignore
    }
  }
  // Album-level artist (e.g. "Various Artists" on compilations) vs track-level
  // artist. Existing rows backfill from the current artist column.
  try {
    db.run(`ALTER TABLE library_songs ADD COLUMN album_artist TEXT NOT NULL DEFAULT ''`);
    db.run(`UPDATE library_songs SET album_artist = artist WHERE album_artist = ''`);
  } catch {
    // Column already exists — ignore
  }
  try {
    db.run(`ALTER TABLE library_songs ADD COLUMN album_artist_id TEXT NOT NULL DEFAULT ''`);
    db.run(`UPDATE library_songs SET album_artist_id = artist_id WHERE album_artist_id = ''`);
  } catch {
    // Column already exists — ignore
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_album_id ON library_songs(album_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_artist_id ON library_songs(artist_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_path ON library_songs(path)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_genre ON library_songs(genre)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_hidden ON library_songs(hidden)`);

  // Cached audio embeddings from the analysis sidecar. The embedding is the
  // expensive artifact — computed once per (song, model), reused for classifier
  // heads and future similarity search. Keyed (song_id, model) so a second
  // embedding model can coexist later. Survives rescans (path-derived song ids).
  db.run(`
    CREATE TABLE IF NOT EXISTS library_embeddings (
      song_id    TEXT NOT NULL,
      model      TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      vec        BLOB NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (song_id, model)
    )
  `);

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
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_library_artists_name ON library_artists(name COLLATE NOCASE)`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_artists_hidden ON library_artists(hidden)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS library_song_artists (
      song_id   TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      role      TEXT NOT NULL DEFAULT 'primary',
      position  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (song_id, artist_id, role)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_song_artists_artist ON library_song_artists(artist_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_song_artists_song ON library_song_artists(song_id)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS library_album_artists (
      album_id  TEXT NOT NULL,
      artist_id TEXT NOT NULL,
      role      TEXT NOT NULL DEFAULT 'primary',
      position  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (album_id, artist_id, role)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_album_artists_artist ON library_album_artists(artist_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_album_artists_album ON library_album_artists(album_id)`);

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

  // User-confirmed metadata corrections (e.g. a mis-tagged artist "<Desconocido>"
  // → "La Portuaria"). Keyed on the scanner's **raw** albumId — the id derived
  // from the unchanged on-disk tags — because the scanner always re-derives that
  // id at scan time and consults this table inside resolveTags to substitute the
  // corrected artist/album/year. `corrected_album_id` (= albumIdFor(correctedArtist,
  // correctedAlbum)) lets the apply handler reverse-look-up the raw row when the
  // user re-corrects an already-corrected album. Same side-table philosophy as
  // library_artwork/library_release_meta: no files moved, songId stays stable,
  // survives full rescans.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_metadata_overrides (
      raw_album_id       TEXT PRIMARY KEY,
      artist             TEXT,
      album              TEXT,
      year               INTEGER,
      corrected_album_id TEXT,
      source             TEXT,
      updated_at         INTEGER NOT NULL
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_metadata_overrides_corrected ON library_metadata_overrides(corrected_album_id)`,
  );

  // On-demand lyrics, keyed on the scanner's path-derived songId. Lyrics are
  // fetched from a lyrics-capable plugin (LRCLIB, …), persisted here, and may be
  // edited by the user (customized=1 protects them from being overwritten by a
  // re-fetch). Plain text is also written back to the file tag, so it survives a
  // move/transcode (which changes songId and orphans this row) — synced LRC is
  // DB-only (no clean embedded standard). Same side-table pattern as
  // library_artwork / library_metadata_overrides.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_lyrics (
      song_id     TEXT PRIMARY KEY,
      plain_text  TEXT,
      synced_text TEXT,
      source      TEXT,
      customized  INTEGER NOT NULL DEFAULT 0,
      updated_at  INTEGER NOT NULL
    )
  `);

  // Native per-user playlists (re-added after the Navidrome removal). Playlists
  // reference songs by the scanner's stable songId; reads JOIN library_songs and
  // drop rows whose song no longer exists (file moved → id changed), so a
  // playlist degrades gracefully rather than showing dead entries.
  //
  // Migration: an older schema exists on some DBs (pre-native-playlists era,
  // before Navidrome was removed) with different columns (no description,
  // updated_at instead of modified_at, TEXT timestamps). Those tables are empty
  // — the feature was disabled — so it's safe to drop and recreate them.
  const playlistsOldSql =
    db
      .query<
        { sql: string },
        []
      >(`SELECT sql FROM sqlite_master WHERE type='table' AND name='playlists'`)
      .get()?.sql ?? '';
  if (playlistsOldSql && !playlistsOldSql.includes('description')) {
    db.transaction(() => {
      db.run(`DROP TABLE IF EXISTS playlist_songs`);
      db.run(`DROP TABLE IF EXISTS playlists`);
    })();
  }

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

  // Curated (system-seeded) playlists vs user playlists. `kind='curated'` rows
  // are globally visible (any user sees them) and read-only through the API —
  // they're managed by scripts/seed-curated-playlists.ts, not user mutations.
  // `cover_art` holds a designed gradient cover URL (e.g. /playlist-covers/<slug>.svg).
  try {
    db.run(`ALTER TABLE playlists ADD COLUMN cover_art TEXT`);
  } catch {
    // Column already exists — ignore.
  }
  try {
    db.run(`ALTER TABLE playlists ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'`);
  } catch {
    // Column already exists — ignore.
  }

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

  // Drop the dead `library_album_tombstones` table (Navidrome-era album-deletion
  // tombstones). The native scanner reads disk directly + synchronously, so the
  // delete path stopped writing it long ago and **nothing reads it** — verified
  // by grep across the codebase. Cleaning up the schema debt per §D2. Idempotent:
  // a no-op on fresh installs that never created it.
  db.run(`DROP TABLE IF EXISTS library_album_tombstones`);

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
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_provenance_navidrome_id ON library_song_provenance(navidrome_id)`,
  );

  // Plugin enablement + consent state. One row per known plugin; absent row ⇒
  // never enabled (default-off compliance posture). config_json is the admin-set
  // config validated against the plugin's manifest schema. consent_* records the
  // admin's acknowledgement of an acquisition plugin's legal disclaimer.
  db.run(`
    CREATE TABLE IF NOT EXISTS plugins (
      id           TEXT PRIMARY KEY,
      enabled      INTEGER NOT NULL DEFAULT 0,
      config_json  TEXT,
      consent_at   INTEGER,
      consent_user TEXT
    )
  `);

  // Plugin-scoped persistent key/value store (the PluginHostContext.storage
  // surface). Namespaced by plugin id so plugins can't read each other's data.
  db.run(`
    CREATE TABLE IF NOT EXISTS plugin_kv (
      plugin_id TEXT NOT NULL,
      key       TEXT NOT NULL,
      value     TEXT NOT NULL,
      PRIMARY KEY (plugin_id, key)
    )
  `);
}

export function getDatabase(): Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase first.');
  return db;
}
