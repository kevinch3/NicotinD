import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { snapshotGuard } from '../fixture-guard';
import { TRACKED_MUSIC_DIR, copyMusicFixtures, diffTrees, hashTree } from '../fixture-music';

// Lives beside the playground tests because `bun test packages/e2e/playground`
// is the one e2e-package unit run `verify` and CI execute.
describe('e2e fixture guard (#1320)', () => {
  const dirs: string[] = [];
  const scratch = () => {
    const d = mkdtempSync(join(tmpdir(), 'nicotind-fixture-guard-'));
    dirs.push(d);
    mkdirSync(join(d, 'music/Artist'), { recursive: true });
    writeFileSync(join(d, 'music/Artist/01.flac'), 'original');
    return d;
  };
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it('passes when the tree is untouched', () => {
    const d = scratch();
    expect(snapshotGuard(d)).not.toThrow();
  });

  it('fails on a file rewritten in place, naming it', () => {
    const d = scratch();
    const check = snapshotGuard(d);
    writeFileSync(join(d, 'music/Artist/01.flac'), 'retagged');
    expect(check).toThrow('music/Artist/01.flac');
  });

  it('fails on a file added or removed', () => {
    const d = scratch();
    const check = snapshotGuard(d);
    writeFileSync(join(d, 'music/Artist/02.flac'), 'landed');
    expect(check).toThrow('music/Artist/02.flac');
    rmSync(join(d, 'music/Artist/02.flac'));
    rmSync(join(d, 'music/Artist/01.flac'));
    expect(check).toThrow('music/Artist/01.flac');
  });

  it('copyMusicFixtures makes a byte-identical, independent copy', () => {
    const dest = join(scratch(), 'copy');
    copyMusicFixtures(dest);
    expect(diffTrees(hashTree(TRACKED_MUSIC_DIR), hashTree(dest))).toEqual([]);
    writeFileSync(join(dest, 'E2E_Test_Artist/E2E_Test_Album/cover.jpg'), 'x');
    expect(diffTrees(hashTree(TRACKED_MUSIC_DIR), hashTree(dest))).toEqual([
      'E2E_Test_Artist/E2E_Test_Album/cover.jpg',
    ]);
  });
});
