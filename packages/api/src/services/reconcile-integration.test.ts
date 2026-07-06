/**
 * Regression test: two-wave hunt lands exactly ONE clean album row.
 *
 * Drives LibraryOrganizer + LibraryScanner directly (not through the watchers).
 * The pre-fix bug: `scanPaths` (the old hook) would add a new row for the wave-2
 * file without pruning the orphan row left by the wave-1 file that autoDedupe
 * deleted. `reconcileAlbums` (Task 3) fixes this by walking the album folder,
 * upserting what's there, and pruning what's gone.
 *
 * Scenario:
 *   wave 1 → circus.mp3      (title "Circus")  → lands in Artist/Circus/
 *   wave 2 → 01 - Circus.mp3 (title "Circus")  → same folder; autoDedupe keeps
 *              "01 - Circus.mp3" (lower relPath wins) and deletes "circus.mp3".
 *
 * Pre-fix: DB still has the ghost row for circus.mp3 → 2 rows, one missing file.
 * Post-fix (reconcileAlbums): walks the dir, prunes the ghost → 1 row, file present.
 */
import { describe, it, expect, afterEach } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  rmSync,
  existsSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import nodeId3 from 'node-id3';
import { applySchema } from '../db.js';
import { LibraryOrganizer } from './library-organizer.js';
import { LibraryScanner } from './library-scanner.js';
import type { CompletedDownloadFile } from './path-inference.js';

const FIXTURE = fileURLToPath(new URL('../../test-fixtures/silence.mp3', import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpRoot(): string {
  mkdirSync(tmpdir(), { recursive: true });
  const root = mkdtempSync(join(tmpdir(), 'nicotind-reconcile-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

interface SeedTags {
  title?: string;
  artist?: string;
  album?: string;
  trackNumber?: number;
}

function seedMp3(dir: string, relPath: string, tags: SeedTags): string {
  const dest = join(dir, relPath);
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(FIXTURE, dest);
  const id3: Record<string, string> = {};
  if (tags.title) id3.title = tags.title;
  if (tags.artist) id3.artist = tags.artist;
  if (tags.album) id3.album = tags.album;
  if (tags.trackNumber !== undefined) id3.trackNumber = String(tags.trackNumber);
  nodeId3.update(id3, dest);
  return dest;
}

describe('two-wave hunt lands one clean album (regression)', () => {
  it('no duplicate rows and surviving file exists on disk after second wave', async () => {
    const music = tmpRoot();
    const staging = join(music, '_staging');
    mkdirSync(staging, { recursive: true });

    const db = new Database(':memory:');
    applySchema(db);
    const organizer = new LibraryOrganizer({ musicDir: music, autoDedupe: true });
    const scanner = new LibraryScanner(music, db);

    // ── Wave 1 ──────────────────────────────────────────────────────────────
    // "circus.mp3" comes in as the first copy. title = "Circus", no track number.
    const wave1File = seedMp3(staging, 'wave1/circus.mp3', {
      title: 'Circus',
      artist: 'Lenny Kravitz',
      album: 'Circus',
    });
    const completed1: CompletedDownloadFile = {
      username: 'peer1',
      directory: 'wave1',
      filename: wave1File,
    };
    const res1 = await organizer.organizeBatch([completed1]);
    await scanner.reconcileAlbums(res1.affectedAlbumDirs);

    const afterWave1 = db
      .query<{ path: string }, []>('SELECT path FROM library_songs')
      .all();
    // Sanity: one row after wave 1.
    expect(afterWave1).toHaveLength(1);
    expect(existsSync(join(music, afterWave1[0]!.path))).toBe(true);

    // ── Wave 2 ──────────────────────────────────────────────────────────────
    // "01 - Circus.mp3" arrives as a higher-quality (re-)download of the same
    // track. Its relPath is lexicographically smaller than "circus.mp3", so
    // autoDedupe keeps it and deletes the wave-1 copy.
    const wave2File = seedMp3(staging, 'wave2/01 - Circus.mp3', {
      title: 'Circus',
      artist: 'Lenny Kravitz',
      album: 'Circus',
      trackNumber: 1,
    });
    const completed2: CompletedDownloadFile = {
      username: 'peer2',
      directory: 'wave2',
      filename: wave2File,
    };
    const res2 = await organizer.organizeBatch([completed2]);

    // autoDedupe must have deleted the wave-1 copy (if it was worse / alphabetically
    // higher) — record this so the assertion below is meaningful.
    // deletedRelPaths tells us which file(s) the organizer removed from disk.
    // The pre-fix bug: without reconcileAlbums the ghost row for that deleted file
    // stays in the DB, giving us 2 rows where one path no longer exists on disk.
    await scanner.reconcileAlbums(res2.affectedAlbumDirs);

    const songs = db
      .query<{ title: string; path: string }, []>('SELECT title, path FROM library_songs')
      .all();

    // Key assertion 1: exactly ONE song row (no orphan ghosts).
    // Pre-fix (scanPaths): would be 2 if autoDedupe deleted the wave-1 file after
    // wave 2 added a new row but before the old row was pruned.
    expect(songs).toHaveLength(1);

    // Key assertion 2: the surviving row points at a file that actually exists.
    // Pre-fix: the ghost row's path pointed at the deleted wave-1 file → false.
    expect(existsSync(join(music, songs[0]!.path))).toBe(true);
  });
});
