import { describe, expect, it, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { dedupeFolder, dupKey } from './album-dedupe.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpFolder(files: Array<[string, number]>): string {
  mkdirSync(tmpdir(), { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), 'nicotind-dedupe-'));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  for (const [name, size] of files) writeFileSync(join(dir, name), 'x'.repeat(size));
  return dir;
}

describe('dedupeFolder', () => {
  it('removes collision-suffix and lossy duplicates, keeping the FLAC', () => {
    const dir = tmpFolder([
      ['01 - Song.flac', 30],
      ['01 - Song.mp3', 11],
      ['01 - Song (2).mp3', 12],
      ['02 - Other.mp3', 9], // unique — untouched
    ]);

    const { deleted, bytesFreed } = dedupeFolder(dir, { apply: true });

    expect(deleted.map((d) => d.name).sort()).toEqual(['01 - Song (2).mp3', '01 - Song.mp3']);
    expect(deleted.every((d) => d.keptName === '01 - Song.flac')).toBe(true);
    expect(bytesFreed).toBe(23);
    const remaining = readdirSync(dir).sort();
    expect(remaining).toEqual(['01 - Song.flac', '02 - Other.mp3']);
  });

  it('dry run reports without deleting', () => {
    const dir = tmpFolder([
      ['01 - Song.mp3', 11],
      ['01 - Song (2).mp3', 12],
    ]);
    const { deleted } = dedupeFolder(dir, { apply: false });
    expect(deleted).toHaveLength(1);
    expect(readdirSync(dir)).toHaveLength(2); // nothing deleted
  });

  it('leaves genuinely distinct tracks alone', () => {
    const dir = tmpFolder([
      ['01 - Believe.mp3', 5],
      ['01 - Believe (acoustic version).flac', 6],
    ]);
    const { deleted } = dedupeFolder(dir, { apply: true });
    expect(deleted).toHaveLength(0);
    expect(existsSync(join(dir, '01 - Believe.mp3'))).toBe(true);
  });
});

// Issue #747: `D-NN - Title` names a disc, and the disc is identity. A leading
// `^\d+` strip used to read `1-05` and `2-05` both as "05 …" and collapse them.
describe('dupKey with a disc prefix', () => {
  it('keeps the same title on two discs apart', () => {
    expect(dupKey('1-05 - Intro.flac')).not.toBe(dupKey('2-05 - Intro.flac'));
  });

  it('treats disc 1 like no disc, so a true copy still collapses', () => {
    expect(dupKey('1-05 - Intro.flac')).toBe(dupKey('05 - Intro.mp3'));
    expect(dupKey('2-05 - Intro (2).mp3')).toBe(dupKey('2-05 - Intro.flac'));
  });

  it('strips the prefix exactly as the NN form does', () => {
    expect(dupKey('1-11 - 7 Steps.flac')).toBe(dupKey('11 - 7 Steps.flac'));
  });

  it('dedupeFolder keeps both discs of a repeated title', () => {
    const dir = tmpFolder([
      ['1-01 - Intro.flac', 20],
      ['2-01 - Intro.flac', 20],
      ['2-01 - Intro (2).mp3', 5],
    ]);
    const { deleted } = dedupeFolder(dir, { apply: true });
    expect(deleted.map((d) => d.name)).toEqual(['2-01 - Intro (2).mp3']);
    expect(readdirSync(dir).sort()).toEqual(['1-01 - Intro.flac', '2-01 - Intro.flac']);
  });
});
