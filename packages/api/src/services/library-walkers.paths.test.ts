import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scanMusicDir } from './library-disk-audit.js';
import { buildBasenameIndex } from './untracked-backfill.js';
import { resolveReservedDirs } from './library-paths.js';

let musicDir: string;

beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'walkers-paths-'));
});
afterEach(() => rmSync(musicDir, { recursive: true, force: true }));

function put(rel: string): void {
  const abs = join(musicDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(8));
}

describe('scanMusicDir', () => {
  test('does not report staging files as library content', () => {
    // Otherwise every in-flight download shows up as an audit finding.
    put('.downloads/peer/01.mp3');
    put('Artist/Album/01.mp3');

    expect(scanMusicDir(musicDir).audioPaths).toEqual(['Artist/Album/01.mp3']);
  });

  test('does not report a reserved dir as an empty dir', () => {
    mkdirSync(join(musicDir, '.unsorted'), { recursive: true });
    put('Artist/Album/01.mp3');

    expect(scanMusicDir(musicDir).emptyDirs).toEqual([]);
  });

  test('still walks an album whose title starts with dots', () => {
    put('DMX/...And Then There Was X/07.mp3');

    expect(scanMusicDir(musicDir).audioPaths).toEqual(['DMX/...And Then There Was X/07.mp3']);
  });
});

describe('buildBasenameIndex', () => {
  test('never indexes a staging file', () => {
    // This index backfills `library_songs.relative_path`; a staging hit would
    // point a canonical library row at a file that is about to be moved.
    put('.downloads/peer/01.mp3');

    expect(buildBasenameIndex(musicDir).get('01.mp3')).toBeUndefined();
  });

  test('indexes ordinary library files', () => {
    put('Artist/Album/01.mp3');

    expect(buildBasenameIndex(musicDir).get('01.mp3')).toEqual(['Artist/Album/01.mp3']);
  });
});

describe('resolveReservedDirs', () => {
  const saved = process.env.NICOTIND_DOWNLOADS_DIR;
  afterEach(() => {
    if (saved === undefined) delete process.env.NICOTIND_DOWNLOADS_DIR;
    else process.env.NICOTIND_DOWNLOADS_DIR = saved;
  });

  test('keeps the shipped defaults when nothing is configured', () => {
    delete process.env.NICOTIND_DOWNLOADS_DIR;
    const reserved = resolveReservedDirs({}, '/data');
    expect(reserved.has('.downloads')).toBe(true);
    expect(reserved.has('.unsorted')).toBe(true);
  });

  test('reserves a configured non-dot staging dir', () => {
    delete process.env.NICOTIND_DOWNLOADS_DIR;
    expect(resolveReservedDirs({ downloads: { dir: 'incoming' } }, '/data').has('incoming')).toBe(
      true,
    );
  });

  test('env wins over the config file', () => {
    // The production image ships no config file, so env is its only source.
    process.env.NICOTIND_DOWNLOADS_DIR = 'from-env';
    const reserved = resolveReservedDirs({ downloads: { dir: 'from-file' } }, '/data');
    expect(reserved.has('from-env')).toBe(true);
    expect(reserved.has('from-file')).toBe(false);
  });

  test('an absolute staging dir contributes no reserved name', () => {
    // It lives outside musicDir, so no walker ever meets it.
    delete process.env.NICOTIND_DOWNLOADS_DIR;
    const reserved = resolveReservedDirs({ downloads: { dir: '/mnt/staging' } }, '/data');
    expect(reserved.has('/mnt/staging')).toBe(false);
    expect(reserved.size).toBe(2);
  });

  test('both walkers skip a configured non-dot staging dir', () => {
    // The defect this fixes: the offline entry points walked with the shipped
    // defaults, so a configured `incoming/` was reported as orphan files by the
    // audit and indexed as library content by the backfill.
    delete process.env.NICOTIND_DOWNLOADS_DIR;
    put('incoming/peer/01.mp3');
    put('Artist/Album/01.mp3');
    const reserved = resolveReservedDirs({ downloads: { dir: 'incoming' } }, '/data');

    expect(scanMusicDir(musicDir, reserved).audioPaths).toEqual(['Artist/Album/01.mp3']);
    expect(buildBasenameIndex(musicDir, reserved).get('01.mp3')).toEqual(['Artist/Album/01.mp3']);

    // And the shipped defaults are exactly what missed it.
    expect(scanMusicDir(musicDir).audioPaths).toContain('incoming/peer/01.mp3');
  });
});
