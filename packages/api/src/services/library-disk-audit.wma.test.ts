import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { scanMusicDir } from './library-disk-audit.js';

let musicDir: string;
beforeEach(() => {
  musicDir = mkdtempSync(join(tmpdir(), 'disk-audit-ext-'));
});
afterEach(() => rmSync(musicDir, { recursive: true, force: true }));

function put(rel: string): void {
  const abs = join(musicDir, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, Buffer.alloc(8));
}

describe('scanMusicDir collects every container the scanner indexes', () => {
  test('a .wma on disk is seen, so its library row is not reported missing', () => {
    // #845: the audit walked with a set lacking .wma while the scanner indexed
    // it, so all six .wma rows on prod reported as `missing_file` — a finding
    // whose obvious remediation deletes a row for a file that is present.
    put('Various/2000 Hit Collection/04 Limp Bizkit - Hot Dog.wma');

    expect(scanMusicDir(musicDir).audioPaths).toEqual([
      'Various/2000 Hit Collection/04 Limp Bizkit - Hot Dog.wma',
    ]);
  });

  test('the formerly-divergent containers are all collected', () => {
    for (const ext of ['wma', 'webm', 'aiff', 'alac', 'ape', 'wv']) put(`A/B/track.${ext}`);
    expect(scanMusicDir(musicDir).audioPaths.length).toBe(6);
  });

  test('non-audio is still ignored', () => {
    put('A/B/cover.jpg');
    put('A/B/album.nfo');
    expect(scanMusicDir(musicDir).audioPaths).toEqual([]);
  });
});
