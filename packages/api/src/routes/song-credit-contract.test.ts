import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC = join(import.meta.dir, '..');

/** Songs here are never served live to a player: an admin report and stored poll snapshots. */
const EXEMPT = [
  { file: 'routes/library.ts', line: 'const allSongs = rows.map(rowToSong);' },
  {
    file: 'services/radio-poll-generate.ts',
    line: 'seed: { song: rowToSong(seedRow), features: stripFeatures(result.seed) },',
  },
  { file: 'services/radio-poll-generate.ts', line: 'song: rowToSong(e.song._row),' },
];

/** How far below a mapping its `attachSongArtists` may sit. */
const ATTACH_WINDOW = 3;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(path);
    return e.name.endsWith('.ts') && !e.name.endsWith('.test.ts') ? [path] : [];
  });
}

interface Site {
  file: string;
  line: string;
  attached: boolean;
}

const sites: Site[] = sourceFiles(SRC).flatMap((path) => {
  const lines = readFileSync(path, 'utf8').split('\n');
  return lines.flatMap((line, i) => {
    if (!line.includes('rowToSong') || line.includes('function rowToSong')) return [];
    if (/^\s*(import\b|rowToSong,?$)/.test(line)) return [];
    return [
      {
        file: relative(SRC, path),
        line: line.trim(),
        attached: lines
          .slice(i, i + ATTACH_WINDOW + 1)
          .some((l) => l.includes('attachSongArtists')),
      },
    ];
  });
});

describe('every song mapped for a client carries its artist links', () => {
  it('sees the mappings it is meant to guard', () => {
    expect(sites.length).toBeGreaterThanOrEqual(11);
  });

  it('finds attachSongArtists right after each mapping', () => {
    const isExempt = (s: Site) => EXEMPT.some((e) => e.file === s.file && e.line === s.line);
    expect(sites.filter((s) => !s.attached && !isExempt(s))).toEqual([]);
  });

  it('has no stale exemption', () => {
    for (const e of EXEMPT) {
      expect(sites.some((s) => s.file === e.file && s.line === e.line)).toBe(true);
    }
  });
});
