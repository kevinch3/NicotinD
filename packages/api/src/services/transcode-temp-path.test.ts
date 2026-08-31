import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Database } from 'bun:sqlite';
import { applySchema } from '../db.js';
import { LibraryScanner } from './library-scanner.js';
import { isHiddenFile } from './library-paths.js';
import { transcodeTempPathFor, sweepStaleTranscodeTemps } from './post-download-transcode.js';

let musicDir: string;

beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'temp-path-test-'));
});
afterEach(() => rmSync(musicDir, { recursive: true, force: true }));

describe('transcodeTempPathFor', () => {
  test('the temp file is hidden, so a crash-orphaned one is never library content', () => {
    // transcodeToOpus already cleans up on every *handled* failure. The leak
    // this guards is the process dying mid-encode (deploy restart, OOM,
    // SIGKILL), where no finally runs. A hidden name makes that cost disk
    // rather than a phantom track.
    const tmp = transcodeTempPathFor('/music/Artist/Album/01 - Track.flac');

    expect(isHiddenFile(basename(tmp))).toBe(true);
    expect(dirname(tmp)).toBe('/music/Artist/Album');
    expect(tmp.endsWith('.opus')).toBe(true);
  });

  test('the temp path is distinct from the destination', () => {
    const tmp = transcodeTempPathFor('/music/Artist/Album/01 - Track.flac');
    expect(tmp).not.toBe('/music/Artist/Album/01 - Track.opus');
  });

  test('a leaked temp file is not scanned as a track', async () => {
    const db = new Database(':memory:');
    applySchema(db);
    const albumDir = join(musicDir, 'Artist', 'Album');
    mkdirSync(albumDir, { recursive: true });
    writeFileSync(join(albumDir, '01 - Track.mp3'), Buffer.alloc(8));
    const leaked = transcodeTempPathFor(join(albumDir, '01 - Track.flac'));
    writeFileSync(leaked, Buffer.alloc(8));

    await new LibraryScanner(musicDir, db).scanFull();

    const paths = db
      .query<{ path: string }, []>('SELECT path FROM scan_cache ORDER BY path')
      .all()
      .map((r) => r.path);
    expect(paths).toEqual(['Artist/Album/01 - Track.mp3']);
    db.close();
  });
});

describe('sweepStaleTranscodeTemps', () => {
  test('removes an old temp file', () => {
    const albumDir = join(musicDir, 'Artist', 'Album');
    mkdirSync(albumDir, { recursive: true });
    // Existing installs already carry leaks under the OLD, scannable name, so
    // the sweep must match both shapes.
    const oldStyle = join(albumDir, '01 - Track.nicotind-transcode.opus');
    const newStyle = transcodeTempPathFor(join(albumDir, '02 - Track.flac'));
    for (const p of [oldStyle, newStyle]) writeFileSync(p, Buffer.alloc(8));
    const hourAgo = Date.now() / 1000 - 3600;
    for (const p of [oldStyle, newStyle]) utimesSync(p, hourAgo, hourAgo);

    const removed = sweepStaleTranscodeTemps(musicDir);

    expect(removed).toBe(2);
    expect(existsSync(oldStyle)).toBe(false);
    expect(existsSync(newStyle)).toBe(false);
  });

  test('leaves a fresh temp alone — it may be an encode in flight', () => {
    const albumDir = join(musicDir, 'Artist', 'Album');
    mkdirSync(albumDir, { recursive: true });
    const inFlight = transcodeTempPathFor(join(albumDir, '01 - Track.flac'));
    writeFileSync(inFlight, Buffer.alloc(8));

    expect(sweepStaleTranscodeTemps(musicDir)).toBe(0);
    expect(existsSync(inFlight)).toBe(true);
  });

  test('never touches a real audio file', () => {
    const albumDir = join(musicDir, 'Artist', 'Album');
    mkdirSync(albumDir, { recursive: true });
    const real = join(albumDir, '01 - Track.opus');
    writeFileSync(real, Buffer.alloc(8));
    const hourAgo = Date.now() / 1000 - 3600;
    utimesSync(real, hourAgo, hourAgo);

    expect(sweepStaleTranscodeTemps(musicDir)).toBe(0);
    expect(existsSync(real)).toBe(true);
  });
});
