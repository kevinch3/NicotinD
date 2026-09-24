import { describe, expect, it, afterEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createQuarantineRun,
  listQuarantineRuns,
  pruneQuarantine,
  quarantineOriginal,
  quarantineRoot,
  DEFAULT_QUARANTINE_KEEP,
  describeQuarantine,
} from './transcode-quarantine.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

function put(root: string, rel: string, body: string): string {
  const abs = join(root, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body);
  return abs;
}

describe('quarantineOriginal', () => {
  it('keeps the original under its musicDir-relative path', () => {
    const music = tmp('q-music-');
    const data = tmp('q-data-');
    const src = put(music, 'Aphex Twin/Drukqs/01 - Avril 14th.flac', 'AUDIO');
    const run = createQuarantineRun(data);

    const dest = quarantineOriginal(run, music, src);

    expect(existsSync(src)).toBe(false);
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, 'utf8')).toBe('AUDIO');
    expect(dest).toBe(join(run, 'Aphex Twin/Drukqs/01 - Avril 14th.flac'));
  });

  it('does not let two albums collide on the same basename', () => {
    // A flat layout would silently overwrite one with the other. Every album
    // has an "01 - Intro"; losing one to the other is the whole risk here.
    const music = tmp('q-music-');
    const data = tmp('q-data-');
    const a = put(music, 'A/Album/01 - Intro.flac', 'FIRST');
    const b = put(music, 'B/Album/01 - Intro.flac', 'SECOND');
    const run = createQuarantineRun(data);

    const da = quarantineOriginal(run, music, a);
    const db = quarantineOriginal(run, music, b);

    expect(da).not.toBe(db);
    expect(readFileSync(da, 'utf8')).toBe('FIRST');
    expect(readFileSync(db, 'utf8')).toBe('SECOND');
  });

  it('refuses a path outside musicDir rather than writing somewhere surprising', () => {
    const music = tmp('q-music-');
    const data = tmp('q-data-');
    const outside = put(tmp('q-other-'), 'stray.flac', 'X');
    const run = createQuarantineRun(data);

    expect(() => quarantineOriginal(run, music, outside)).toThrow(/outside musicDir/);
    expect(existsSync(outside)).toBe(true);
  });
});

describe('createQuarantineRun', () => {
  it('does not merge two runs started in the same second', () => {
    const data = tmp('q-data-');
    const at = new Date(2026, 8, 20, 12, 0, 0);
    const a = createQuarantineRun(data, at);
    const b = createQuarantineRun(data, at);
    expect(a).not.toBe(b);
    expect(listQuarantineRuns(data)).toHaveLength(2);
  });
});

describe('pruneQuarantine', () => {
  function seedRuns(data: string, n: number): void {
    for (let i = 1; i <= n; i++) {
      const dir = join(quarantineRoot(data), `transcode-2026092${i}-120000`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'x.flac'), 'x');
    }
  }

  it('keeps the newest runs and drops the rest', () => {
    const data = tmp('q-data-');
    seedRuns(data, 5);
    expect(pruneQuarantine(data, 2)).toBe(3);
    expect(listQuarantineRuns(data)).toEqual([
      'transcode-20260925-120000',
      'transcode-20260924-120000',
    ]);
  });

  it('never empties the backup, even when asked to keep zero', () => {
    // "Deleting a backup to make room for a backup is never right."
    const data = tmp('q-data-');
    seedRuns(data, 3);
    pruneQuarantine(data, 0);
    expect(listQuarantineRuns(data)).toHaveLength(1);
  });

  it('leaves anything it did not create alone', () => {
    const data = tmp('q-data-');
    seedRuns(data, 3);
    const manual = join(quarantineRoot(data), 'keep-this-by-hand');
    mkdirSync(manual, { recursive: true });
    writeFileSync(join(manual, 'note.txt'), 'operator parked this here');

    pruneQuarantine(data, 1);

    // Name-scoped: the pattern is the allowlist, not "everything in the root".
    expect(existsSync(manual)).toBe(true);
    expect(existsSync(quarantineRoot(data))).toBe(true);
  });

  it('is a no-op on a root that does not exist', () => {
    const data = tmp('q-data-');
    expect(pruneQuarantine(data, DEFAULT_QUARANTINE_KEEP)).toBe(0);
    expect(listQuarantineRuns(data)).toEqual([]);
  });
});

describe('describeQuarantine (#1255)', () => {
  it('lists runs newest first with their file counts, and the space under them', () => {
    const data = tmp('qd-');
    const older = createQuarantineRun(data, new Date(2026, 8, 1));
    const newer = createQuarantineRun(data, new Date(2026, 8, 2));
    put(older, 'A/B/01.flac', 'x');
    put(older, 'A/B/02.flac', 'x');
    put(newer, 'C/D/01.flac', 'x');
    const d = describeQuarantine(data);
    expect(d.root).toBe(quarantineRoot(data));
    expect(d.runs).toEqual([
      { name: 'transcode-20260902-000000', files: 1 },
      { name: 'transcode-20260901-000000', files: 2 },
    ]);
    expect(d.filesystem!.totalBytes).toBeGreaterThan(0);
  });

  it('answers an empty quarantine, not an error, before any conversion ran', () => {
    const d = describeQuarantine(tmp('qd-empty-'));
    expect(d.runs).toEqual([]);
    expect(d.filesystem).not.toBeNull();
  });
});
