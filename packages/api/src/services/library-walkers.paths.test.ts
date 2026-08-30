import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scanMusicDir } from './library-disk-audit.js';
import { buildBasenameIndex } from './untracked-backfill.js';

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
