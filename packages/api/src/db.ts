import { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { armReviewHold, reviewHoldArmed } from './services/download-review-store.js';

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
/**
 * Additive column migration, idempotent across boots.
 *
 * `applySchema` runs on every start, so a column that already exists is the
 * normal case — but this checks `PRAGMA table_info` rather than catching,
 * which is the point: the `try { ALTER } catch {}` this replaced swallowed a
 * genuine migration bug (a typo'd type, a bad default) exactly as silently as
 * an already-applied column, and the damage only surfaced much later as a
 * missing column. Making "already there" a *condition* lets a real failure
 * throw loudly at boot.
 *
 * Returns whether the column was added, so a one-time backfill can be gated on
 * it instead of re-running a full table scan on every boot.
 *
 * Additive only — never a destructive migration. See docs/design-patterns.md.
 */
export function addColumnIfMissing(
  db: Database,
  table: string,
  column: string,
  decl: string,
): boolean {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (cols.some((c) => c.name === column)) return false;
  db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${decl}`);
  return true;
}

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
  addColumnIfMissing(db, 'users', 'status', "TEXT NOT NULL DEFAULT 'active'");

  // Add welcome_dismissed column to existing user_settings table
  addColumnIfMissing(db, 'user_settings', 'welcome_dismissed', 'INTEGER NOT NULL DEFAULT 0');

  // Add autoplay_on_load column to existing user_settings table (opt-in
  // resume-on-page-load; default off — see PlayerService.maybeResumeAutoplay).
  addColumnIfMissing(db, 'user_settings', 'autoplay_on_load', 'INTEGER NOT NULL DEFAULT 0');
  // Listening-history consent (issue #454). Opt-OUT: default 1, so the Stats
  // tab and the radio recency demotion work out of the box; a user turns it off
  // in Settings → Privacy. Gated further by an instance setting and an env
  // floor — see services/privacy.ts.
  addColumnIfMissing(db, 'user_settings', 'history_enabled', 'INTEGER NOT NULL DEFAULT 1');

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
  addColumnIfMissing(db, 'album_jobs', 'target_files_json', 'TEXT');

  // Artist name, captured at hunt-download time. Lets the cross-peer fallback
  // fire a *fresh* slskd search ("<artist> <track>") for tracks no recorded
  // alternate can supply, instead of giving up the moment the stale alternates
  // are exhausted. Nullable for pre-existing rows (those skip the fresh-search
  // step and behave exactly as before).
  addColumnIfMissing(db, 'album_jobs', 'artist_name', 'TEXT');

  // Album title, for the "incomplete albums" UI surface (so a user can see which
  // hunts ended exhausted and re-trigger them). Nullable for pre-existing rows.
  addColumnIfMissing(db, 'album_jobs', 'album_title', 'TEXT');

  // Auto-retry of exhausted jobs: how many times a job has been revived for
  // another fallback wave, and when it was last revived (cooldown gate). Lets
  // the fallback periodically re-attempt albums whose peers were offline at
  // hunt time without churning — bounded by exhaustedMaxRevives + cooldown.
  addColumnIfMissing(db, 'album_jobs', 'revive_count', 'INTEGER NOT NULL DEFAULT 0');
  addColumnIfMissing(db, 'album_jobs', 'last_revived_at', 'INTEGER');

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
  // Per-file quality captured at enqueue time (slskd search response bitRate)
  // or upgraded post-organize (library scan populates library_songs.bit_rate).
  // Optional so legacy rows survive untouched; null renders as "no quality info".
  addColumnIfMissing(db, 'acquisition_job_items', 'bit_rate_kbps', 'INTEGER');
  addColumnIfMissing(db, 'acquisition_job_items', 'audio_format', 'TEXT');

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

  addColumnIfMissing(db, 'completed_downloads', 'navidrome_id', 'TEXT');

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
  addColumnIfMissing(db, 'playlist_visibility', 'created_by', 'TEXT REFERENCES users(id)');
  addColumnIfMissing(db, 'playlist_visibility', 'created_at', 'TEXT');
  addColumnIfMissing(db, 'playlist_visibility', 'modified_by', 'TEXT REFERENCES users(id)');
  addColumnIfMissing(db, 'playlist_visibility', 'modified_at', 'TEXT');

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
  addColumnIfMissing(db, 'acquire_jobs', 'stage', 'TEXT');
  addColumnIfMissing(db, 'acquire_jobs', 'storage_path', 'TEXT');
  // The distinct set of destination albums the job's files landed in (JSON
  // array of {albumArtist, albumTitle, albumId}) — a job whose files span
  // multiple albums (e.g. a large playlist) needs more than the single
  // first-landed storage_path to link every album, not just the first one.
  addColumnIfMissing(db, 'acquire_jobs', 'dest_albums_json', 'TEXT');
  // Per-track download state (JSON array of {title, status}), in playlist
  // order where known. spotdl/archive know the full track list upfront;
  // yt-dlp/spotdl discover titles incrementally, so the array is
  // appended-to / status-updated in place by title match rather than fully
  // known ahead of time. Powers the "Now downloading: X / Next: Y, Z" UI.
  addColumnIfMissing(db, 'acquire_jobs', 'tracks_json', 'TEXT');
  // Marks a URL acquire job whose source URL was a *playlist* (Spotify playlist,
  // YouTube playlist, archive.org item flagged as playlist via `as=playlist`).
  // When 1, AcquireWatcher's post-ingest step materializes a per-user native
  // playlist from the landed tracks in playlist order. See
  // docs/playlist-from-acquisition.md.
  addColumnIfMissing(db, 'acquire_jobs', 'is_playlist', 'INTEGER NOT NULL DEFAULT 0');
  // Set after the generated playlist is created; lets the Downloads card link
  // straight to the playlist detail page. ON DELETE SET NULL so a user who
  // removes the playlist doesn't leave a dangling reference on the job row.
  addColumnIfMissing(
    db,
    'acquire_jobs',
    'playlist_id',
    'TEXT REFERENCES playlists(id) ON DELETE SET NULL',
  );
  // Dominant bitrate (kbps) and codec for the URL-acquire job's landed files,
  // populated by AcquireWatcher.ingest via ffprobe AFTER the lossless→opus
  // transcode so the value matches what landed in the library. Powers the
  // "· 320 kbps" chip on the download card. Nullable: legacy / pre-feature
  // rows survive untouched, and the chip is hidden when both are null.
  addColumnIfMissing(db, 'acquire_jobs', 'bit_rate_kbps', 'INTEGER');
  addColumnIfMissing(db, 'acquire_jobs', 'audio_format', 'TEXT');

  // Per-track plugin output for URL acquire jobs, in download order. Separate
  // from acquire_jobs.tracks_json because the post-ingest playlist step needs
  // (title, path) in row order — the JSON column is title-only and powers the
  // "Now:" / "Next:" card UI, which doesn't need paths. Rows are written by
  // recordAcquireJobTrack (acquire-playlist.ts), which upserts keyed on
  // (job_id, title): re-emits for the same title (downloading → done, or a
  // retry replaying the list) update in place, new titles append at
  // MAX(position)+1 — so `position` is first-appearance (= playlist) order.
  // `path` is the file basename the plugin knows it's about to write ('' for
  // title-only sources like spotdl) — used to resolve the post-scan
  // library_song via the basename stem of the organized relative path, so two
  // tracks with identical titles in one playlist still map to distinct songs.
  db.run(`
    CREATE TABLE IF NOT EXISTS acquire_job_tracks (
      job_id   TEXT NOT NULL REFERENCES acquire_jobs(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      title    TEXT NOT NULL,
      status   TEXT NOT NULL,
      path     TEXT NOT NULL,
      PRIMARY KEY (job_id, position)
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_acquire_job_tracks_job ON acquire_job_tracks(job_id)`);

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
  // Orphan-prune stamp (issue #319): an acquisition row keyed on a path whose
  // song is gone is unreachable through the per-track provenance UI. The daily
  // orphan pass marks→grace→sweeps them, after `repointOrphanedAcquisitions`
  // has already recovered the ones that are the only provenance for a live song.
  addColumnIfMissing(db, 'acquisitions', 'orphaned_at', 'INTEGER');

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
      resource_type     TEXT    NOT NULL CHECK (resource_type IN ('playlist', 'album', 'artist')),
      resource_id       TEXT    NOT NULL,
      created_by        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at        INTEGER NOT NULL,
      first_accessed_at INTEGER,
      expires_at        INTEGER
    )
  `);
  // Issue #229: 'artist' joined the shareable resource set. Legacy DBs carry the
  // old two-value CHECK constraint which would reject an artist share row, so
  // rebuild the table (same recreate-to-drop-a-CHECK pattern as acquire_jobs above).
  const shareTokensSql = db
    .query<{ sql: string }, []>(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'share_tokens'`,
    )
    .get();
  if (shareTokensSql && !shareTokensSql.sql.includes("'artist'")) {
    db.run('ALTER TABLE share_tokens RENAME TO share_tokens_old');
    db.run(`
      CREATE TABLE share_tokens (
        token             TEXT    PRIMARY KEY,
        resource_type     TEXT    NOT NULL CHECK (resource_type IN ('playlist', 'album', 'artist')),
        resource_id       TEXT    NOT NULL,
        created_by        TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at        INTEGER NOT NULL,
        first_accessed_at INTEGER,
        expires_at        INTEGER
      )
    `);
    db.run(
      `INSERT INTO share_tokens (token, resource_type, resource_id, created_by, created_at, first_accessed_at, expires_at)
       SELECT token, resource_type, resource_id, created_by, created_at, first_accessed_at, expires_at FROM share_tokens_old`,
    );
    db.run('DROP TABLE share_tokens_old');
  }

  // Device pairing (QR link): short-lived single-use tokens minted by a logged-in
  // user and exchanged (unauthenticated claim) for a normal JWT bound to a
  // paired_devices row. Deleting the device row is the revocation mechanism —
  // the JWT dies at its next refresh.
  db.run(`
    CREATE TABLE IF NOT EXISTS pairing_tokens (
      token      TEXT    PRIMARY KEY,
      code       TEXT    NOT NULL,
      user_id    TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      claimed_at INTEGER
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_pairing_tokens_code ON pairing_tokens (code)`);

  db.run(`
    CREATE TABLE IF NOT EXISTS paired_devices (
      id           TEXT    PRIMARY KEY,
      user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      platform     TEXT    NOT NULL,
      created_at   INTEGER NOT NULL,
      last_seen_at INTEGER
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_paired_devices_user ON paired_devices (user_id)`);

  // TV sign-in via phone approval (device-grant direction of pairing): the
  // UNAUTHENTICATED device mints a request (token + 6-char code) and polls;
  // a signed-in user approves the code from their own device; the claim then
  // exchanges the token for a device-bound JWT. Unlike pairing_tokens (minted
  // by an authenticated user), anonymous minting makes unbounded growth a
  // real risk — expired rows are pruned on every mint.
  db.run(`
    CREATE TABLE IF NOT EXISTS login_requests (
      token               TEXT    PRIMARY KEY,
      code                TEXT    NOT NULL,
      device_name         TEXT    NOT NULL,
      platform            TEXT    NOT NULL,
      created_at          INTEGER NOT NULL,
      expires_at          INTEGER NOT NULL,
      approved_by_user_id TEXT,
      approved_at         INTEGER,
      claimed_at          INTEGER
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_login_requests_code ON login_requests (code)`);

  // MCP agent tokens (issue #232): a scoped, revocable bearer an external
  // LLM/agent uses to curate the library via /api/mcp. Only the sha256 HASH of
  // the token is stored (a leak of this table never leaks a live token — a
  // stronger posture than pairing_tokens' raw storage, justified because these
  // are long-lived). The effective role is capped at `refiner` regardless of
  // the owner's role, so an admin who mints one does NOT get an admin agent.
  // Deleting/`revoked_at`-stamping the row is the revocation mechanism, enforced
  // on every request (the token is looked up by hash each call).
  db.run(`
    CREATE TABLE IF NOT EXISTS agent_tokens (
      id           TEXT    PRIMARY KEY,
      user_id      TEXT    NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name         TEXT    NOT NULL,
      scope        TEXT    NOT NULL DEFAULT 'refiner:curate',
      token_hash   TEXT    NOT NULL,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at   INTEGER,
      revoked_at   INTEGER
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_agent_tokens_user ON agent_tokens (user_id)`);
  db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_tokens_hash ON agent_tokens (token_hash)`);

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
  // Album-level licence aggregate: the unanimous licence code across all the
  // album's tracks (else NULL = mixed/unknown), so "entirely Public Domain"
  // albums/compilations are filterable + badgeable. ALTER-only (like the song
  // enrichment columns), NOT added to either CREATE block above — that keeps a
  // single column order across fresh + migrated DBs and, crucially, keeps the
  // 'ep'-migration rebuild's `INSERT ... SELECT *` column counts matched.
  addColumnIfMissing(db, 'library_albums', 'licence', 'TEXT');
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_albums_licence ON library_albums(licence)`);

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
      sample_rate   INTEGER,
      bit_depth     INTEGER,
      channels      INTEGER,
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
  // Grace-period stamp for the orphan pruner (issue #313). Additive, so an
  // existing cache keeps every entry and simply starts being swept.
  addColumnIfMissing(db, 'scan_cache', 'orphaned_at', 'INTEGER');
  // Add bpm to existing library_songs tables (safe if it already exists). Set by
  // tag reads at scan time and by on-demand track analysis.
  addColumnIfMissing(db, 'library_songs', 'bpm', 'INTEGER');
  // Musical key (e.g. "C major" / "A minor"), same additive pattern as bpm — read
  // from tags at scan time, filled by on-demand/windowed key analysis.
  addColumnIfMissing(db, 'library_songs', 'key', 'TEXT');
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
    // Rights/licence code (LICENCE_VOCAB, e.g. 'public-domain'/'cc-by') + its
    // provenance. Same additive/COALESCE-preserved contract as bpm/key: read from
    // file tags (LICENSE/COPYRIGHT/WCOP) at scan time, filled by the `licence`
    // enrichment task (tag → MusicBrainz), or set by a curator. `licence_source`
    // ∈ {tag, musicbrainz, user}; a NULL `licence` means unknown, so the
    // enrichment task (WHERE licence IS NULL) keeps trying to resolve it.
    'licence TEXT',
    'licence_source TEXT',
    // Extrinsic popularity (issue #220): a 0–1 scalar derived from a global
    // listen count, + its provenance. Unlike genre/bpm/licence this is NOT read
    // from file tags — it is a network-only signal — so the scanner never writes
    // it and it survives rescans by simply being absent from the upsert. Filled
    // by the `popularity` enrichment task (`popularity_source` ∈ {listenbrainz});
    // a NULL means unknown, so the task (WHERE popularity IS NULL) keeps trying.
    'popularity REAL',
    'popularity_source TEXT',
  ]) {
    const [name, ...decl] = col.split(' ');
    addColumnIfMissing(db, 'library_songs', name, decl.join(' '));
  }
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_licence ON library_songs(licence)`);
  db.run(`CREATE INDEX IF NOT EXISTS idx_library_songs_popularity ON library_songs(popularity)`);

  // Container technical details — sample rate (Hz), bit depth (bits/sample,
  // lossless-only), channel count. Read from music-metadata's format at scan
  // time (no DSP), same additive pattern as bit_rate; purely file-derived so a
  // rescan always overwrites them (no COALESCE preservation).
  addColumnIfMissing(db, 'library_songs', 'sample_rate', 'INTEGER');
  addColumnIfMissing(db, 'library_songs', 'bit_depth', 'INTEGER');
  addColumnIfMissing(db, 'library_songs', 'channels', 'INTEGER');
  // "Landed" timestamp (epoch ms) — NULL means the song is *quarantined*: it has
  // been scanned into the DB (so the windowed enrichment tasks can operate on it)
  // but is hidden from every library listing until its required processing steps
  // finish. The library-processing service is the ONLY writer that sets a
  // timestamp here (see graduatePending); the scanner deliberately never touches
  // this column on insert or rescan, so a fresh scan mints NULL (quarantined) and
  // a rescan of an already-landed song preserves its value. A one-time backfill
  // below lands every pre-existing row so upgrades never retroactively hide music.
  addColumnIfMissing(db, 'library_songs', 'landed_at', 'INTEGER');
  // Album-level artist (e.g. "Various Artists" on compilations) vs track-level
  // artist. Existing rows backfill from the current artist column.
  // The backfill is gated on the column having just been added, matching the
  // old try-block semantics: on every later boot the ALTER threw and the
  // UPDATE was skipped with it, so it never re-scanned the whole table.
  if (addColumnIfMissing(db, 'library_songs', 'album_artist', `TEXT NOT NULL DEFAULT ''`)) {
    db.run(`UPDATE library_songs SET album_artist = artist WHERE album_artist = ''`);
  }
  if (addColumnIfMissing(db, 'library_songs', 'album_artist_id', `TEXT NOT NULL DEFAULT ''`)) {
    db.run(`UPDATE library_songs SET album_artist_id = artist_id WHERE album_artist_id = ''`);
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
  //
  // `file_size` is the content check (issue #258): the song id is derived from
  // the *path*, so replacing a file in place — a re-download at better quality,
  // a repaired rip — keeps the id and silently serves an embedding describing
  // audio that is no longer there, which the Radio scorer then matches against.
  // Recording the size at analysis time makes that a cache miss, mirroring the
  // reset already used by `library_song_analysis_failures`. NULL = written
  // before this column existed; treated as "unknown, still usable" so an
  // upgrade doesn't discard every embedding in the library at once.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_embeddings (
      song_id    TEXT NOT NULL,
      model      TEXT NOT NULL,
      dim        INTEGER NOT NULL,
      vec        BLOB NOT NULL,
      file_size  INTEGER,
      orphaned_at INTEGER,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (song_id, model)
    )
  `);
  addColumnIfMissing(db, 'library_embeddings', 'file_size', 'INTEGER');
  // When this row was first seen with no `library_songs` owner (issue #259).
  // NULL = currently owned. Deleting a song leaves its embedding behind by
  // design (no FK cascade — see docs/cache-invalidation.md), so this is what
  // bounds the growth without giving up that design. See `orphan-prune.ts`.
  addColumnIfMissing(db, 'library_embeddings', 'orphaned_at', 'INTEGER');

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
      orphaned_at  INTEGER,
      last_attempt INTEGER NOT NULL,
      PRIMARY KEY (song_id, task)
    )
  `);
  addColumnIfMissing(db, 'library_song_analysis_failures', 'orphaned_at', 'INTEGER');

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
  addColumnIfMissing(db, 'library_artists', 'split_compound', 'INTEGER NOT NULL DEFAULT 0');
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

  // Download inbox triage (#411): records curator approve/discard decisions for
  // quarantined albums. Pending is DERIVED (quarantined songs + no covering row),
  // never stored, so this table cannot drift from scanner state. reviewed_at is
  // ISO-8601 so it compares lexicographically with library_songs.created — a song
  // scanned after the decision re-pends its album (re-download after discard).
  db.run(`
    CREATE TABLE IF NOT EXISTS download_reviews (
      album_id    TEXT PRIMARY KEY,
      state       TEXT NOT NULL CHECK (state IN ('approved','discarded')),
      reviewed_by TEXT,
      reviewed_at TEXT NOT NULL
    )
  `);

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
  addColumnIfMissing(db, 'playlists', 'cover_art', 'TEXT');
  addColumnIfMissing(db, 'playlists', 'kind', "TEXT NOT NULL DEFAULT 'user'");

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

  // Genre overrides (issue #187 A3): the one genre write that can REPLACE a
  // song's primary rather than append to it. Keyed at the granularity the
  // SOURCE provides — MusicBrainz gives genres per release-group (album),
  // Lidarr per artist, a future Essentia head per track — so one row fixes
  // every song it covers and is inherited by tracks downloaded later.
  // `key` is normalizeArtistForGrouping(name) / albumGroupKey(artist, album) /
  // the song id, matching what buildLibrary computes. `genres` is a ';'-joined
  // ordered list, primary first; '' suppresses every genre (junk drop).
  // status='pending' is the review queue — a column rather than reclassify-
  // genres.ts's review FILE because a file has no memory of rejection, so
  // re-running --propose over 2,474 artists would re-propose everything the
  // curator already declined. Side table: survives rescans/prunes.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_genre_overrides (
      scope       TEXT NOT NULL,   -- 'artist' | 'album' | 'song'
      key         TEXT NOT NULL,
      genres      TEXT NOT NULL,
      source      TEXT NOT NULL,   -- 'musicbrainz' | 'lidarr' | 'user' | 'essentia'
      mbid        TEXT,
      confidence  REAL,
      status      TEXT NOT NULL,   -- 'applied' | 'pending' | 'rejected'
      note        TEXT,
      mode        TEXT,           -- 'replace' | 'append'; NULL = legacy source rule
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_genre_overrides_status ON library_genre_overrides(status)`,
  );
  // Issue #260. Deliberately nullable with no default: an existing row must keep
  // the semantics it was applied under (source='user' replaced), so backfilling
  // a value here would silently re-interpret every curator decision ever made.
  addColumnIfMissing(db, 'library_genre_overrides', 'mode', 'TEXT');

  // Persisted MusicBrainz ids, so genre (and any future MB) lookups can query
  // BY ID instead of fuzzy-by-name — the hazard docs/library-scanner.md warns
  // about, which reproduced immediately during #187 measurement ("Emilia" the
  // Argentine artist exact-name-matched a Swedish Emilia). A side table rather
  // than library_albums.mbid / library_artists.mbid columns because those rows
  // are pruned by synced_at, which would drop a resolved id whenever an album
  // temporarily disappeared.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_mbids (
      scope      TEXT NOT NULL,   -- 'artist' | 'album'
      key        TEXT NOT NULL,
      mbid       TEXT NOT NULL,
      source     TEXT NOT NULL,   -- 'tag' | 'lidarr' | 'mb-search' | 'user'
      confidence REAL NOT NULL,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (scope, key)
    )
  `);

  // Non-MusicBrainz external ids, generalized (issue #194). library_mbids stays
  // MB-specific (heavily referenced); this holds provider-scoped ids so a
  // release match "locks in" once made — the whole benefit over A1, which re-runs
  // its fuzzy gate every window. One table for all providers rather than a
  // migration per provider (the mistake library_artist_discogs_id would have been).
  db.run(`
    CREATE TABLE IF NOT EXISTS library_external_ids (
      provider    TEXT NOT NULL,   -- 'discogs'
      scope       TEXT NOT NULL,   -- 'release' | 'artist'
      key         TEXT NOT NULL,
      external_id TEXT NOT NULL,   -- provider id, stored verbatim (never re-derived)
      source      TEXT NOT NULL,   -- 'mbid' | 'name-search'
      fetched_at  INTEGER NOT NULL,
      PRIMARY KEY (provider, scope, key)
    )
  `);

  // Discogs (or a future provider) bio + external links for an artist (issue
  // #195). Keyed on the scanner-minted artist id — like library_artist_identity
  // / library_artist_aliases — so it survives rescans. `manual_override` mirrors
  // library_artists.manual_override: once a curator hand-edits, the background
  // task and the refresh route both leave the row alone. A row with bio=NULL and
  // urls='[]' is a written TOMBSTONE (no MBID, no Discogs relation, or a fetch
  // that came back empty) — its mere presence is what keeps a permanent miss out
  // of the background task's pending set, the same "presence = done" model
  // artist-image uses via library_artwork.
  db.run(`
    CREATE TABLE IF NOT EXISTS library_artist_meta (
      artist_id       TEXT PRIMARY KEY,
      bio             TEXT,
      urls            TEXT NOT NULL DEFAULT '[]',
      fetched_at      INTEGER NOT NULL,
      source          TEXT NOT NULL,   -- 'discogs' | 'user'
      manual_override INTEGER NOT NULL DEFAULT 0
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

  // Remote acquisition addons registered by URL (acquisition addon protocol —
  // docs/acquisition-addon-protocol.md). token is the outbound bearer we must
  // replay on every call, so it is stored plaintext (same class as the Soulseek
  // creds); manifest_json is the manifest snapshot taken at registration so the
  // card renders at boot even while the addon is down.
  db.run(`
    CREATE TABLE IF NOT EXISTS addon_registrations (
      id            TEXT PRIMARY KEY,
      url           TEXT NOT NULL,
      token         TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      added_at      INTEGER NOT NULL,
      added_by      TEXT NOT NULL
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

  // Every version this server has ever booted (Immich's version-history
  // pattern) — invaluable for support ("did this DB ever run 0.1.180?").
  // Written once per version by recordBootVersion (services/update-check.ts).
  db.run(`
    CREATE TABLE IF NOT EXISTS version_history (
      version       TEXT PRIMARY KEY,
      first_seen_at INTEGER NOT NULL
    )
  `);

  // Admin audit log: who did which destructive/curation action to what, when.
  // Written by recordAudit (services/audit-log.ts) from curator/admin routes.
  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      at          INTEGER NOT NULL,
      user_id     TEXT NOT NULL,
      username    TEXT,
      action      TEXT NOT NULL,
      target_kind TEXT,
      target_id   TEXT,
      detail      TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC)`);

  // Generation-feedback: a dev golden-dataset. Every "generated"/inferred output
  // (v1: album-hunt recognition) captured as an (input, output, verdict) snapshot
  // that scripts/feedback-to-fixtures.ts exports into replayable TDD fixtures.
  // verdict NULL = pending (captured at hunt time, not yet graded). input_json /
  // output_json hold the full snapshot so a fixture replays the pure recognizer
  // offline. Written by services/generation-feedback.ts. See docs/generation-feedback.md.
  db.run(`
    CREATE TABLE IF NOT EXISTS generation_feedback (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      at              INTEGER NOT NULL,
      user_id         TEXT NOT NULL,
      username        TEXT,
      resource_type   TEXT NOT NULL,
      resource_ref    TEXT,
      verdict         TEXT,
      note            TEXT,
      input_json      TEXT NOT NULL,
      output_json     TEXT NOT NULL,
      item_flags_json TEXT,
      engine_version  TEXT
    )
  `);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_generation_feedback_type_at
       ON generation_feedback (resource_type, at DESC)`,
  );

  // Admin dev-mode toggle: when on, generated results surface a capture toast so
  // the admin can grade them (see generation_feedback above). Per-user, default
  // off — invisible to non-admins.
  addColumnIfMissing(db, 'user_settings', 'feedback_capture', 'INTEGER NOT NULL DEFAULT 0');

  // Listening history: one append-only row per playback session, per user.
  // Written by services/play-history.ts from client-reported raw facts; the
  // "did this count as a play" rule is applied here at insert, never by the
  // client, so it stays retunable. See docs/listening-history.md.
  //
  // Two deliberate schema choices:
  //  - No FK on song_id. Song ids are sha1(path) and re-mint on any move or
  //    retag, and the scanner rebuilds library_songs wholesale — a cascade
  //    would delete listening history on a routine rescan.
  //  - title/artist/album are snapshotted onto the event for the same reason:
  //    a year review must survive the id re-mint that would otherwise orphan
  //    the row (the failure that produced dangling playlist_songs, #259).
  db.run(`
    CREATE TABLE IF NOT EXISTS play_events (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      client_event_id TEXT NOT NULL UNIQUE,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      song_id         TEXT NOT NULL,
      title           TEXT,
      artist          TEXT,
      album           TEXT,
      at              INTEGER NOT NULL,
      ms_played       INTEGER NOT NULL,
      duration_ms     INTEGER,
      counted         INTEGER NOT NULL DEFAULT 0,
      reason          TEXT NOT NULL,
      source          TEXT,
      device          TEXT
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_play_events_user_at ON play_events (user_id, at DESC)`);
  db.run(
    `CREATE INDEX IF NOT EXISTS idx_play_events_song_counted
       ON play_events (song_id, user_id) WHERE counted = 1`,
  );

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

  // Hold-for-review bootstrap exemption (issue #417): arm the one-way
  // `review_hold_armed_v1` marker here (weaker condition than the runtime
  // `maybeArmReviewHold` — any landed song, quarantine need not be empty) so
  // an *upgrade* of an established library is armed immediately, including
  // one with a pending review inbox at deploy time — nothing lands unreviewed
  // just because the marker hadn't existed yet before this migration shipped.
  // A genuinely fresh database (no landed song at all) stays unarmed;
  // `maybeArmReviewHold` (called from `graduatePending`) arms it at runtime
  // once the scanner's first bootstrap drain fully lands, so an initial
  // library import carrying `holdForReview: true` isn't flooded into the
  // inbox.
  if (!reviewHoldArmed(db)) {
    const anyLanded = db
      .query<{ 1: number }, []>(`SELECT 1 FROM library_songs WHERE landed_at IS NOT NULL LIMIT 1`)
      .get();
    if (anyLanded) armReviewHold(db);
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
