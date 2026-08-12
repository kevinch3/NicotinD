import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * The addon's OWN SQLite database (docs/acquisition-addon-protocol.md). Holds
 * source-side state only — hunt fallback jobs, retry ledgers, transfer
 * completion tracking, and the protocol job ledger the host polls. Library
 * knowledge lives host-side and crosses the protocol as request inputs.
 *
 * `album_jobs`/`transfer_retries`/`hidden_transfers`/`completed_downloads`
 * mirror the api schemas (the services that moved here keep their SQL); the
 * api's copies stay live for the in-process path until the phase-2 cutover.
 */
export function applySchema(db: Database): void {
  db.run(`PRAGMA journal_mode = WAL`);

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
      created_at INTEGER NOT NULL,
      target_files_json TEXT,
      artist_name TEXT,
      album_title TEXT,
      revive_count INTEGER NOT NULL DEFAULT 0,
      last_revived_at INTEGER
    )
  `);
  db.run(`CREATE INDEX IF NOT EXISTS idx_album_jobs_state ON album_jobs (state)`);

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

  db.run(`
    CREATE TABLE IF NOT EXISTS hidden_transfers (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

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
    ON completed_downloads (completed_at)
  `);

  // Protocol job ledger — what GET /addon/v1/jobs serves the host.
  db.run(`
    CREATE TABLE IF NOT EXISTS addon_jobs (
      id TEXT PRIMARY KEY,
      intent TEXT NOT NULL,
      artist TEXT,
      album TEXT,
      canonical_tracks_json TEXT,
      album_job_id INTEGER,
      state TEXT NOT NULL DEFAULT 'active',
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS addon_job_items (
      job_id TEXT NOT NULL,
      item_id TEXT NOT NULL,
      title TEXT,
      username TEXT NOT NULL,
      filename TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      bit_rate_kbps INTEGER,
      audio_format TEXT,
      state TEXT NOT NULL DEFAULT 'queued',
      bytes_transferred INTEGER,
      file_ready INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (job_id, item_id)
    )
  `);

  // Addon-side persisted config (host-pushed via PUT /addon/v1/config).
  db.run(`
    CREATE TABLE IF NOT EXISTS addon_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

let instance: Database | null = null;

/** Open (or create) the addon database at `path` and apply the schema. */
export function openDatabase(path: string): Database {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  applySchema(db);
  return db;
}

export function getDatabase(path?: string): Database {
  if (!instance) {
    instance = openDatabase(path ?? process.env.SLSKD_ADDON_DB ?? 'data/slskd-addon.sqlite');
  }
  return instance;
}

/** Test seam: swap/clear the singleton. */
export function setDatabase(db: Database | null): void {
  instance = db;
}
