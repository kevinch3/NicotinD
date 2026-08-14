import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  planImportChunks,
  scanImportSource,
  validateImportSource,
  type ImportScanDir,
} from './import-scan.js';

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'import-scan-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function seed(rel: string, bytes = 10): string {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, Buffer.alloc(bytes));
  return abs;
}

describe('scanImportSource', () => {
  it('groups audio files by directory with sizes and skips non-audio', () => {
    seed('Artist/Album/01 - One.mp3', 100);
    seed('Artist/Album/02 - Two.flac', 200);
    seed('Artist/Album/cover.jpg', 50);
    seed('loose.opus', 30);
    const res = scanImportSource(root);
    expect(res.files).toBe(3);
    expect(res.bytes).toBe(330);
    expect(res.unsupportedFiles).toBe(1);
    expect(res.dirs.map((d) => d.dir)).toEqual(['.', 'Artist/Album']);
    const album = res.dirs.find((d) => d.dir === 'Artist/Album')!;
    expect(album.files.map((f) => f.rel)).toEqual([
      'Artist/Album/01 - One.mp3',
      'Artist/Album/02 - Two.flac',
    ]);
    expect(album.bytes).toBe(300);
  });

  it('never follows symlinks and counts them as skipped', () => {
    const target = mkdtempSync(join(tmpdir(), 'import-scan-target-'));
    try {
      writeFileSync(join(target, 'outside.mp3'), Buffer.alloc(10));
      seed('real.mp3');
      symlinkSync(target, join(root, 'linked-dir'));
      symlinkSync(join(target, 'outside.mp3'), join(root, 'linked.mp3'));
      const res = scanImportSource(root);
      expect(res.files).toBe(1);
      expect(res.skippedSymlinks).toBe(2);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('skips dot-entries entirely', () => {
    seed('.hidden/secret.mp3');
    seed('.DS_Store', 5);
    seed('Album/song.mp3');
    const res = scanImportSource(root);
    expect(res.files).toBe(1);
    expect(res.unsupportedFiles).toBe(0);
  });

  it('truncates at the file cap', () => {
    for (let i = 0; i < 5; i++) seed(`Album/${i}.mp3`);
    const res = scanImportSource(root, { maxFiles: 3 });
    expect(res.truncated).toBe(true);
    expect(res.files).toBe(3);
  });

  it('truncates past the depth cap', () => {
    seed('a/b/c/deep.mp3');
    const res = scanImportSource(root, { maxDepth: 2 });
    expect(res.truncated).toBe(true);
    expect(res.files).toBe(0);
  });

  it('is deterministic: dirs and files come back sorted', () => {
    seed('B/two.mp3');
    seed('A/one.mp3');
    seed('A/a.mp3');
    const res = scanImportSource(root);
    expect(res.dirs.map((d) => d.dir)).toEqual(['A', 'B']);
    expect(res.dirs[0]!.files.map((f) => f.rel)).toEqual(['A/a.mp3', 'A/one.mp3']);
  });
});

describe('planImportChunks', () => {
  const dir = (name: string, files: number): ImportScanDir => ({
    dir: name,
    files: Array.from({ length: files }, (_, i) => ({ rel: `${name}/${i}.mp3`, size: 1 })),
    bytes: files,
  });

  it('packs whole dirs up to the target', () => {
    const chunks = planImportChunks([dir('a', 3), dir('b', 3), dir('c', 3)], 6);
    expect(chunks.map((c) => c.dirs.map((d) => d.dir))).toEqual([['a', 'b'], ['c']]);
    expect(chunks[0]!.files).toBe(6);
  });

  it('never splits a directory: an oversized dir is its own chunk', () => {
    const chunks = planImportChunks([dir('small', 2), dir('huge', 500), dir('tail', 2)], 200);
    expect(chunks.map((c) => c.dirs.map((d) => d.dir))).toEqual([['small'], ['huge'], ['tail']]);
    expect(chunks[1]!.files).toBe(500);
  });

  it('returns no chunks for no dirs', () => {
    expect(planImportChunks([], 200)).toEqual([]);
  });
});

describe('validateImportSource', () => {
  let musicDir: string;
  let dataDir: string;

  beforeEach(() => {
    musicDir = join(root, 'music');
    dataDir = join(root, 'data');
    mkdirSync(musicDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(join(root, 'source'), { recursive: true });
  });

  it('accepts a plain sibling folder and returns its realpath', () => {
    const res = validateImportSource(join(root, 'source'), musicDir, dataDir);
    expect(res.ok).toBe(true);
  });

  it('rejects a missing path', () => {
    expect(validateImportSource(join(root, 'nope'), musicDir, dataDir)).toEqual({
      ok: false,
      code: 'NOT_FOUND',
    });
  });

  it('rejects a file path', () => {
    const f = seed('source/track.mp3');
    expect(validateImportSource(f, musicDir, dataDir)).toEqual({ ok: false, code: 'NOT_DIR' });
  });

  it('rejects the music dir itself and anything inside it', () => {
    expect(validateImportSource(musicDir, musicDir, dataDir)).toEqual({
      ok: false,
      code: 'INSIDE_LIBRARY',
    });
    mkdirSync(join(musicDir, 'sub'));
    expect(validateImportSource(join(musicDir, 'sub'), musicDir, dataDir)).toEqual({
      ok: false,
      code: 'INSIDE_LIBRARY',
    });
  });

  it('rejects a folder that contains the music dir', () => {
    expect(validateImportSource(root, musicDir, dataDir)).toEqual({
      ok: false,
      code: 'CONTAINS_LIBRARY',
    });
  });

  it('rejects the data dir and its parents (when they do not also contain the library)', () => {
    expect(validateImportSource(dataDir, musicDir, dataDir)).toEqual({
      ok: false,
      code: 'INSIDE_DATA_DIR',
    });
    mkdirSync(join(dataDir, 'staging'), { recursive: true });
    expect(validateImportSource(join(dataDir, 'staging'), musicDir, dataDir)).toEqual({
      ok: false,
      code: 'INSIDE_DATA_DIR',
    });
  });

  it('rejects a symlinked source that resolves inside the music dir', () => {
    mkdirSync(join(musicDir, 'Artist'));
    symlinkSync(join(musicDir, 'Artist'), join(root, 'innocent'));
    expect(validateImportSource(join(root, 'innocent'), musicDir, dataDir)).toEqual({
      ok: false,
      code: 'INSIDE_LIBRARY',
    });
  });

  it('a sibling with a shared name prefix is not "inside"', () => {
    mkdirSync(join(root, 'music-imports'));
    const res = validateImportSource(join(root, 'music-imports'), musicDir, dataDir);
    expect(res.ok).toBe(true);
  });
});
