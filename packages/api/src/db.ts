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

  db.run(`
    CREATE TABLE IF NOT EXISTS hidden_transfers (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  return db;
}

export function getDatabase(): Database {
  if (!db) throw new Error('Database not initialized. Call initDatabase first.');
  return db;
}
