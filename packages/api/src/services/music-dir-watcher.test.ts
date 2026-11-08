import { afterEach, describe, expect, it } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { Database } from 'bun:sqlite';
import nodeId3 from 'node-id3';
import { applySchema } from '../db.js';
import { LibraryScanner } from './library-scanner.js';
import { reservedDirsFor } from './library-paths.js';
import { MusicDirWatcher } from './music-dir-watcher.js';

/**
 * #1740: files dropped into the music dir (scp, Samba, Syncthing: the most
 * common way a self-hoster adds music) stayed invisible until a manual Sync.
 *
 * These use the real fs.watch on a real temp dir. That matters: Bun's
 * `{ recursive: true }` watch does not report anything inside a directory
 * created after the watch started, so a new album under an existing artist,
 * the everyday case, produced no event at all.
 */
const QUIET_MS = 150;
const BOUND_MS = 3_000;
const FIXTURE = fileURLToPath(new URL('../../test-fixtures/silence.mp3', import.meta.url));

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function musicRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nicotind-watch-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function start(musicDir: string, onAlbums: (dirs: string[]) => unknown, onRemoved = () => {}) {
  const watcher = new MusicDirWatcher({
    musicDir,
    reserved: reservedDirsFor(),
    onAlbums: async (dirs) => void (await onAlbums(dirs)),
    onRemoved,
    quietMs: QUIET_MS,
  });
  watcher.start();
  cleanups.push(() => watcher.stop());
  return watcher;
}

async function until(cond: () => boolean, ms = BOUND_MS): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await Bun.sleep(25);
  }
  return cond();
}

const settle = () => Bun.sleep(100); // let the initial watch tree attach

describe('MusicDirWatcher', () => {
  it('reports a new album folder under an artist that already existed', async () => {
    const music = musicRoot();
    mkdirSync(join(music, 'Artist'));
    const seen: string[] = [];
    start(music, (dirs) => seen.push(...dirs));
    await settle();

    mkdirSync(join(music, 'Artist', 'New Album'));
    writeFileSync(join(music, 'Artist', 'New Album', '01.flac'), 'x');

    expect(await until(() => seen.includes(join(music, 'Artist', 'New Album')))).toBe(true);
  });

  it('reports the album folder of a whole new tree dropped in at once', async () => {
    const music = musicRoot();
    const seen: string[] = [];
    start(music, (dirs) => seen.push(...dirs));
    await settle();

    mkdirSync(join(music, 'New Artist', 'Album', 'CD1'), { recursive: true });
    writeFileSync(join(music, 'New Artist', 'Album', 'CD1', '01.mp3'), 'x');

    expect(await until(() => seen.includes(join(music, 'New Artist', 'Album', 'CD1')))).toBe(true);
  });

  it('waits for a copy to go quiet, then reports once', async () => {
    const music = musicRoot();
    mkdirSync(join(music, 'A', 'B'), { recursive: true });
    const calls: string[][] = [];
    start(music, (dirs) => calls.push(dirs));
    await settle();

    const file = join(music, 'A', 'B', 'big.flac');
    for (let i = 0; i < 5; i++) {
      writeFileSync(file, 'x'.repeat(i + 1)); // a slow copy keeps writing
      await Bun.sleep(QUIET_MS / 2);
    }
    expect(await until(() => calls.length > 0)).toBe(true);
    await Bun.sleep(QUIET_MS * 3);
    expect(calls).toHaveLength(1);
  });

  it('ignores the acquisition staging dir and hidden files', async () => {
    const music = musicRoot();
    mkdirSync(join(music, '.downloads', 'job'), { recursive: true });
    mkdirSync(join(music, 'Artist', 'Album'), { recursive: true });
    const seen: string[] = [];
    start(music, (dirs) => seen.push(...dirs));
    await settle();

    writeFileSync(join(music, '.downloads', 'job', '01.flac'), 'x');
    writeFileSync(join(music, 'Artist', 'Album', '.syncthing.01.flac.tmp'), 'x');

    await Bun.sleep(QUIET_MS * 4);
    expect(seen).toEqual([]);
  });

  it('asks for a full sync when something is removed', async () => {
    const music = musicRoot();
    mkdirSync(join(music, 'Artist', 'Album'), { recursive: true });
    writeFileSync(join(music, 'Artist', 'Album', '01.flac'), 'x');
    let removed = 0;
    start(
      music,
      () => {},
      () => void removed++,
    );
    await settle();

    rmSync(join(music, 'Artist', 'Album'), { recursive: true });

    expect(await until(() => removed > 0)).toBe(true);
  });
});

describe('MusicDirWatcher → LibraryScanner', () => {
  it('a tagged file dropped into a new album folder is in the library with no manual scan', async () => {
    const music = musicRoot();
    mkdirSync(join(music, 'Existing Artist'));
    const db = new Database(':memory:');
    applySchema(db);
    const scanner = new LibraryScanner(music, db);
    start(music, (dirs) => scanner.reconcileAlbums(dirs));
    await settle();

    const dest = join(music, 'Existing Artist', 'Dropped Album', '01 - Dropped.mp3');
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(FIXTURE, dest);
    nodeId3.update(
      { title: 'Dropped', artist: 'Existing Artist', album: 'Dropped Album', trackNumber: '1' },
      dest,
    );

    const titles = () =>
      db
        .query<{ title: string }, []>('SELECT title FROM library_songs')
        .all()
        .map((r) => r.title);
    expect(await until(() => titles().includes('Dropped'), 5_000)).toBe(true);
  });
});
