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

  db.run(`
    CREATE TABLE IF NOT EXISTS share_tokens (
      token             TEXT    PRIMARY KEY,
      resource_type     TEXT    NOT NULL CHECK (resource_type IN ('playlist', 'album')),
      resource_id       TEXT    NOT NULL,
      created_by        TEXT    NOT NULL REFERENCES users(id),
      created_at        INTEGER NOT NULL,
      first_accessed_at INTEGER,
      expires_at        INTEGER
    )
  `);

  return db;
}

export function getDatabase(): Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase first.');
  return db;
}
