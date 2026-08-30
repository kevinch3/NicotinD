import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryScanner } from './library-scanner.js';

let musicDir: string;
let db: Database;

beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'scan-paths-test-'));
  db = new Database(':memory:');
  applySchema(db);
});

afterEach(() => {
  db.close();
  rmSync(musicDir, { recursive: true, force: true });
});

function put(rel: string): void {
  const abs = join(musicDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(8));
}

/** Paths the walk actually visited, via the scan cache it writes per file. */
function scanned(): string[] {
  return db
    .query<{ path: string }, []>('SELECT path FROM scan_cache ORDER BY path')
    .all()
    .map((r) => r.path);
}

describe('scanFull path conventions', () => {
  it('skips a reserved staging dir at the top level', async () => {
    put('.downloads/peer-folder/01.mp3');
    put('Artist/Album/01.mp3');

    await new LibraryScanner(musicDir, db).scanFull();

    expect(scanned()).toEqual(['Artist/Album/01.mp3']);
  });

  it('skips any dot-prefixed top-level dir, not only the ones we name', async () => {
    // Syncthing keeps prior versions of every synced file here; scanning it
    // would ingest a second copy of the whole library.
    put('.stversions/Artist/Album/01.mp3');
    put('Artist/Album/01.mp3');

    await new LibraryScanner(musicDir, db).scanFull();

    expect(scanned()).toEqual(['Artist/Album/01.mp3']);
  });

  it('keeps an album whose title starts with dots', async () => {
    // Both are real albums in the production library. An unrestricted dot rule
    // would silently drop them.
    put('DMX/...And Then There Was X/07 - Party Up.mp3');
    put('Memphis La Blusera/...Etc/07 - Arrepentido.mp3');

    await new LibraryScanner(musicDir, db).scanFull();

    expect(scanned()).toEqual([
      'DMX/...And Then There Was X/07 - Party Up.mp3',
      'Memphis La Blusera/...Etc/07 - Arrepentido.mp3',
    ]);
  });

  it('skips macOS AppleDouble sidecars at any depth', async () => {
    // extname('._01 - Track.mp3') is '.mp3', so these match AUDIO_EXTENSIONS
    // and are scanned as audio without the hidden-file rule.
    put('Artist/Album/._01 - Track.mp3');
    put('Artist/Album/01 - Track.mp3');

    await new LibraryScanner(musicDir, db).scanFull();

    expect(scanned()).toEqual(['Artist/Album/01 - Track.mp3']);
  });
});

describe('scanPaths path conventions', () => {
  it('refuses a reserved path a caller passes explicitly', async () => {
    // A walk-only guard is one forgotten call site away from the bug it exists
    // to prevent, so the filter lives here too.
    put('.downloads/peer-folder/01.mp3');

    await new LibraryScanner(musicDir, db).scanPaths(['.downloads/peer-folder/01.mp3']);

    expect(scanned()).toEqual([]);
  });

  it('still scans an ordinary path', async () => {
    put('Artist/Album/01.mp3');

    await new LibraryScanner(musicDir, db).scanPaths(['Artist/Album/01.mp3']);

    expect(scanned()).toEqual(['Artist/Album/01.mp3']);
  });
});
