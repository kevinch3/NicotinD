import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryScanner, mapPool } from './library-scanner.js';
import { loadScanCache, partitionByCache } from './scan-cache.js';

let musicDir: string;
let db: Database;

beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'incr-scan-test-'));
  db = new Database(':memory:');
  applySchema(db);
});

afterEach(() => {
  db.close();
  rmSync(musicDir, { recursive: true, force: true });
});

function fileStatsFor(relPaths: string[]) {
  return relPaths.map((rel) => {
    const st = statSync(join(musicDir, rel));
    return { abs: join(musicDir, rel), relPath: rel, size: st.size, mtimeMs: st.mtimeMs };
  });
}

describe('scanFull incremental cache', () => {
  it('caches every scanned file so a second scan re-parses nothing unchanged', async () => {
    const albumDir = join(musicDir, 'Artist', 'Album');
    mkdirSync(albumDir, { recursive: true });
    writeFileSync(join(albumDir, '01.mp3'), Buffer.alloc(8));
    writeFileSync(join(albumDir, '02.mp3'), Buffer.alloc(8));

    await new LibraryScanner(musicDir, db).scanFull();

    // Every file landed in the scan cache...
    const cached = db.query<{ c: number }, []>('SELECT COUNT(*) AS c FROM scan_cache').get()!.c;
    expect(cached).toBe(2);

    // ...so the next scan sees only cache hits, zero misses (no parseFile).
    const files = fileStatsFor(['Artist/Album/01.mp3', 'Artist/Album/02.mp3']);
    const { hits, misses } = partitionByCache(files, loadScanCache(db));
    expect(hits).toHaveLength(2);
    expect(misses).toHaveLength(0);
  });

  it('re-parses a file after its mtime changes (edited on disk)', async () => {
    const albumDir = join(musicDir, 'A', 'B');
    mkdirSync(albumDir, { recursive: true });
    const f = join(albumDir, 't.mp3');
    writeFileSync(f, Buffer.alloc(8));

    await new LibraryScanner(musicDir, db).scanFull();

    // Bump mtime forward — simulates a re-tag/edit.
    const future = new Date(Date.now() + 60_000);
    utimesSync(f, future, future);

    const files = fileStatsFor(['A/B/t.mp3']);
    const { hits, misses } = partitionByCache(files, loadScanCache(db));
    expect(hits).toHaveLength(0);
    expect(misses).toHaveLength(1);
  });
});

describe('mapPool', () => {
  it('preserves input order regardless of completion order', async () => {
    const out = await mapPool([30, 10, 20, 5], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms * 2;
    });
    expect(out).toEqual([60, 20, 40, 10]);
  });

  it('never exceeds the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapPool([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
