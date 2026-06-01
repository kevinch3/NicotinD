import { describe, it, expect, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { applySchema } from '../db.js';
import { backfillRelativePaths, buildBasenameIndex } from './untracked-backfill.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpMusic(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'nicotind-backfill-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function seedFile(root: string, rel: string): void {
  const full = join(root, rel);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, 'x');
}

function addRow(db: Database, key: string, basename: string): void {
  db.run(
    `INSERT INTO completed_downloads (transfer_key, username, directory, filename, relative_path, basename, completed_at)
     VALUES (?, 'u', 'd', ?, NULL, ?, 0)`,
    [key, basename, basename],
  );
}

describe('untracked backfill', () => {
  it('buildBasenameIndex maps lowercased basenames to relative paths', () => {
    const root = tmpMusic();
    seedFile(root, 'Soda Stereo/Canción Animal/01 - Cancion Animal.flac');
    const index = buildBasenameIndex(root);
    expect(index.get('01 - cancion animal.flac')).toEqual([
      'Soda Stereo/Canción Animal/01 - Cancion Animal.flac',
    ]);
  });

  it('fills in relative_path for a unique on-disk match', () => {
    const root = tmpMusic();
    seedFile(root, 'Artist/Album/song.mp3');
    const db = new Database(':memory:');
    applySchema(db);
    addRow(db, 'k1', 'song.mp3');

    const res = backfillRelativePaths(db, root, { apply: true });
    expect(res).toEqual({ matched: 1, ambiguous: 0, unresolved: 0 });

    const row = db.query('SELECT relative_path AS r FROM completed_downloads WHERE transfer_key = ?').get('k1') as { r: string };
    expect(row.r).toBe('Artist/Album/song.mp3');
  });

  it('skips ambiguous (multi-match) and unresolved rows; dry run writes nothing', () => {
    const root = tmpMusic();
    seedFile(root, 'A1/Album/dup.mp3');
    seedFile(root, 'A2/Album/dup.mp3');
    const db = new Database(':memory:');
    applySchema(db);
    addRow(db, 'dup', 'dup.mp3'); // two matches → ambiguous
    addRow(db, 'missing', 'gone.mp3'); // no match → unresolved

    const res = backfillRelativePaths(db, root, { apply: false });
    expect(res).toEqual({ matched: 0, ambiguous: 1, unresolved: 1 });

    const stillNull = db
      .query('SELECT COUNT(*) AS c FROM completed_downloads WHERE relative_path IS NULL')
      .get() as { c: number };
    expect(stillNull.c).toBe(2);
  });
});
