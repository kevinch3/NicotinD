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
  applyPerformancePragmas(db);
  applySchema(db);
  return db;
}

/**
 * Connection-level performance pragmas. Split out so it's directly testable and
 * so both `initDatabase` and any auxiliary connection can share one policy.
 *
 * - `synchronous=NORMAL`: safe under WAL (no corruption on app crash; only a
 *   power-loss window can lose the last commit) and much faster for the large
 *   scan-write transaction than the default FULL.
 * - `cache_size=-64000`: ~64 MiB page cache (negative = KiB) — keeps hot library
 *   pages resident across listing queries.
 * - `mmap_size`: memory-map up to 256 MiB so reads avoid syscall copies.
 * - `busy_timeout=5000`: wait out a concurrent writer (the background scan)
 *   instead of erroring immediately, matching the one-off scripts.
 */
export function applyPerformancePragmas(db: Database): void {
  db.run('PRAGMA synchronous=NORMAL');
  db.run('PRAGMA cache_size=-64000');
  db.run('PRAGMA mmap_size=268435456');
  db.run('PRAGMA busy_timeout=5000');
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
      welcome_dismissed INTEGER NOT NULL DEFAULT 0,
      autoplay_on_load INTEGER NOT NULL DEFAULT 0
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

  // Add autoplay_on_load column to existing user_settings table (opt-in
  // resume-on-page-load; default off — see PlayerService.maybeResumeAutoplay).
  try {
    db.run(`ALTER TABLE user_settings ADD COLUMN autoplay_on_load INTEGER NOT NULL DEFAULT 0`);
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

  // Unified acquisition jobs: every download (slskd hunt, fallback recovery,
  // direct grab, track search, URL acquire) belongs to one job whose
  // transfer↔job linkage is stored at enqueue time — never re-derived by
  // string-matching folders. `album_jobs` above remains the cross-peer
  // fallback engine's private table, owned via album_job_id. For kind='url'
  // the id equals acquire_jobs.id (mirror row; acquire_jobs stays authoritative).
  db.run(`
    CREATE TABLE IF NOT EXISTS acquisition_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      method TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'active',
      stage TEXT NOT NULL DEFAULT 'downloading',
      artist_name TEXT,
      album_title TEXT,
      lidarr_album_id INTEGER,
      release_mbid TEXT,
      artist_mbid TEXT,
      genres_json TEXT,
      year INTEGER,
      canonical_tracks_json TEXT,
      album_job_id INTEGER,
      source_ref TEXT,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_state ON acquisition_jobs (state)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_acquisition_jobs_lidarr ON acquisition_jobs (lidarr_album_id)`,
  );

  // One row per expected file. The row is stable across peers: when the
  // fallback re-pulls a track from a new peer, username/filename/transfer_key
  // are updated in place (attempts++), so relative_path/song_id accumulate on
  // one row. transfer_key is the EXACT enqueued `username::filename` string —
  // backslashes and case preserved (same contract as transfer_retries).
  db.run(`
    CREATE TABLE IF NOT EXISTS acquisition_job_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id TEXT NOT NULL REFERENCES acquisition_jobs(id) ON DELETE CASCADE,
      track_title TEXT,
      username TEXT,
      filename TEXT,
      transfer_key TEXT,
      attempts INTEGER NOT NULL DEFAULT 1,
      state TEXT NOT NULL DEFAULT 'downloading',
      relative_path TEXT,
      song_id TEXT,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_acq_items_job ON acquisition_job_items (job_id)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_acq_items_transfer ON acquisition_job_items (transfer_key)`,
  );

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
    .query<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'acquire_jobs'`,
    )
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
  // The distinct set of destination albums the job's files landed in (JSON
  // array of {albumArtist, albumTitle, albumId}) — a job whose files span
  // multiple albums (e.g. a large playlist) needs more than the single
  // first-landed storage_path to link every album, not just the first one.
  try {
    db.run(`ALTER TABLE acquire_jobs ADD COLUMN dest_albums_json TEXT`);
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
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_library_albums_classification ON library_albums(classification)`,
  );
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_artist_id ON library_albums(artist_id)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_created ON library_albums(created DESC)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_library_albums_name ON library_albums(name COLLATE NOCASE)`,
  );
  // Composite index covering the default /albums grid: WHERE hidden = 0
  // AND classification IN (...) ORDER BY created DESC. Lets SQLite satisfy the
  // filter + sort from one index instead of picking a single-column index then
  // sorting the result set.
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_library_albums_grid ON library_albums(hidden, classification, created DESC)`,
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
  // Scan cache: raw, IO-derived tags keyed by relative path. Lets a full rescan
  // skip music-metadata parseFile() for files whose size + mtime are unchanged.
  // Stores the *raw* ScannedTrack (not resolved values) so the resolveTags /
  // override pipeline still runs identically — overrides survive rescans.
  db.run(`
    CREATE TABLE IF NOT EXISTS scan_cache (
      path       TEXT PRIMARY KEY,
      size       INTEGER NOT NULL,
      mtime_ms   REAL NOT NULL,
      track_json TEXT NOT NULL
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
  // "Landed" timestamp (epoch ms) — NULL means the song is *quarantined*: it has
  // been scanned into the DB (so the windowed enrichment tasks can operate on it)
  // but is hidden from every library listing until its required processing steps
  // finish. The library-processing service is the ONLY writer that sets a
  // timestamp here (see graduatePending); the scanner deliberately never touches
  // this column on insert or rescan, so a fresh scan mints NULL (quarantined) and
  // a rescan of an already-landed song preserves its value. A one-time backfill
  // below lands every pre-existing row so upgrades never retroactively hide music.
  try {
    db.run(`ALTER TABLE library_songs ADD COLUMN landed_at INTEGER`);
  } catch {
    // Column already exists — ignore
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
  // Landing-gate listing suppression filters on `landed_at IS NULL`; index it so
  // the "any song quarantined?" fast-path check and the per-album exclusion stay
  // cheap even with a large library.
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_landed ON library_songs(landed_at)`);

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

  // Per-(song, task) analysis failure ledger. A file that hard-fails a decode/
  // sidecar analysis (e.g. a corrupt "Invalid data" mp3) is recorded here; once
  // fail_count reaches the task's attempt cap the windowed processor excludes it
  // (see enrichment/analysis-failures.ts), so a permanently-broken file stops
  // being retried — and re-alerting — every run. file_size is the size at the
  // last failure: a re-download changes it, which clears the skip and lets the
  // repaired file be retried. A successful analysis also clears the row.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_song_analysis_failures (
      song_id      TEXT NOT NULL,
      task         TEXT NOT NULL,
      fail_count   INTEGER NOT NULL DEFAULT 0,
      last_error   TEXT,
      file_size    INTEGER,
      last_attempt INTEGER NOT NULL,
      PRIMARY KEY (song_id, task)
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
      split_compound  INTEGER NOT NULL DEFAULT 0,
      synced_at       INTEGER NOT NULL
    )
  `);
  // Scanner-owned flag (distinct from the user-curated `hidden`): 1 when this
  // artist entity's name is a compound the splitter resolves into >1 primary
  // credit ("Charly García y Luis Alberto Spinetta"). The grid hides these —
  // only the member artists show as tiles — while the row stays functional for
  // direct navigation/search. Recomputed on every scan, so it self-corrects
  // when the split authority changes.
  try {
    db.run(`ALTER TABLE library_artists ADD COLUMN split_compound INTEGER NOT NULL DEFAULT 0`);
  } catch {
    // Column already exists — ignore
  }
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
      .query<{ sql: string }, []>(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='playlists'`,
      )
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

  // Cached artist-split authority. For a compound artist string like
  // "Bob Marley & The Wailers" (one act) vs "Bob Marley, Peter Tosh" (two artists),
  // this records the resolved decision so the *synchronous* scanner can split with
  // zero network calls. Keyed on artistIdFor(rawCompoundName) and kept off the
  // scanner-managed tables (like library_artwork / library_release_meta) so it
  // survives full rescans/prunes and can be written at hunt/ingest time before scan.
  // Populated by the `artist-identity` windowed enrichment task (Lidarr/MB) and, as a
  // fallback, inferred purely from atomic library names when no authority row exists.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_artist_identity (
      artist_key  TEXT NOT NULL,
      raw_name    TEXT NOT NULL,
      decision    TEXT NOT NULL,   -- 'single' | 'split'
      members     TEXT,            -- JSON string[] of resolved member names (decision='split')
      source      TEXT NOT NULL,   -- 'lidarr' | 'mb' | 'library'
      checked_at  INTEGER NOT NULL,
      PRIMARY KEY (artist_key)
    )
  `);

  // Artist-name alias map: a spelling variant ("Snoop Dog") → the canonical display
  // spelling ("Snoop Dogg") the scanner should mint IDs from. Applied in buildLibrary
  // *before* artistIdFor/albumIdFor run, so variants collapse into one entity on the
  // next rescan — deriveMbidAliases writes rows only on MBID equality (two library
  // artists resolving to the same MusicBrainz artist), never string distance;
  // source='user' rows come from the admin merge flow and are never overwritten.
  // Side table (like library_artist_identity): survives rescans/prunes.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_artist_aliases (
      alias_norm     TEXT NOT NULL,  -- normalizeArtistForGrouping(variant spelling)
      canonical_name TEXT NOT NULL,  -- display spelling to mint IDs from
      mbid           TEXT,
      source         TEXT NOT NULL,  -- 'mbid' | 'user'
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (alias_norm)
    )
  `);

  // Full multi-genre set per song (position 0 = the primary, which is also
  // mirrored into library_songs.genre for zero-breakage single-value reads).
  // Scanner-managed like library_song_artists: rebuilt from tags on rescan.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_song_genres (
      song_id  TEXT NOT NULL,
      genre    TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (song_id, genre)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_song_genres_genre ON library_song_genres(genre)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_song_genres_song ON library_song_genres(song_id)`);

  // Genre alias map (human-gated, like library_artist_aliases): a raw tag
  // value → its canonical form. Canonical may be a ';'-joined LIST (one alias
  // expands to many genres — fixes no-separator concatenations like
  // "RockPunk") or '' (junk value dropped, e.g. "Other"). Applied by
  // splitGenres in buildLibrary before aggregation, so rescans of unchanged
  // messy files still produce clean genres without rewriting the files.
  // Side table: survives rescans/prunes. Populated by reclassify-genres.ts.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_genre_aliases (
      alias      TEXT NOT NULL COLLATE NOCASE,
      canonical  TEXT NOT NULL,
      source     TEXT NOT NULL,   -- 'rule' | 'user'
      created_at INTEGER NOT NULL,
      PRIMARY KEY (alias)
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

  // One-time landing backfill. The landed_at column defaults to NULL (quarantined)
  // for every row, so an upgrade of an existing library would otherwise hide the
  // entire catalogue behind the new processing gate. Land every pre-existing song
  // exactly once, marker-gated on library_sync_state so it never re-runs: a second
  // run after new quarantined downloads existed would wrongly land them mid-flight.
  // Runs here (end of applySchema) because library_sync_state is created above.
  const landingBackfillDone = db
    .query<{ value: string }, [string]>(`SELECT value FROM library_sync_state WHERE key = ?`)
    .get('landing_backfill_v1');
  if (!landingBackfillDone) {
    const now = Date.now();
    db.transaction(() => {
      db.run(`UPDATE library_songs SET landed_at = ? WHERE landed_at IS NULL`, [now]);
      db.run(
        `INSERT OR REPLACE INTO library_sync_state (key, value, updated_at) VALUES (?, '1', ?)`,
        ['landing_backfill_v1', now],
      );
    })();
  }

  // One-time scan-cache flush for multi-genre. Pre-multi-genre cache rows kept
  // only the FIRST genre frame (ScannedTrack.genre = common.genre[0]), so a
  // file tagged with several genre frames can't recover its extras from cache.
  // Version-marker-gated: absent marker ⇒ flush once (next scan re-parses all
  // files), then never again.
  const scanCacheVersion = db
    .query<{ value: string }, [string]>(`SELECT value FROM library_sync_state WHERE key = ?`)
    .get('scan_cache_version');
  if (scanCacheVersion?.value !== '2') {
    const now = Date.now();
    db.transaction(() => {
      db.run(`DELETE FROM scan_cache`);
      db.run(
        `INSERT OR REPLACE INTO library_sync_state (key, value, updated_at) VALUES (?, '2', ?)`,
        ['scan_cache_version', now],
      );
    })();
  }
}

export function getDatabase(): Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase first.');
  return db;
}
