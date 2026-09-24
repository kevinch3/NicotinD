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

describe('run-once setup stays in the main process', () => {
  it('isMainProcess is false inside a Playwright worker', async () => {
    const { isMainProcess } = await import('../fixture-music');
    expect(isMainProcess({})).toBe(true);
    expect(isMainProcess({ TEST_WORKER_INDEX: '0' })).toBe(false);
  });

  it('the config wipes data dirs and copies fixtures only behind isMainProcess()', async () => {
    // Each worker re-evaluates the config; an unguarded wipe unlinked the live
    // servers' nicotind.db mid-suite, so any new connection by path failed.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(join(import.meta.dir, '../playwright.config.ts'), 'utf8');
    const guard = src.indexOf('if (!externalBaseUrl && isMainProcess()) {');
    expect(guard).toBeGreaterThan(-1);
    const end = src.indexOf('\n}\n', guard);
    const guarded = src.slice(guard, end);
    const outside = src.slice(0, guard) + src.slice(end);
    for (const call of [
      'rmSync(dataDir',
      'rmSync(onboardingDataDir',
      'rmSync(tvDataDir',
      'copyMusicFixtures(',
    ]) {
      expect(guarded).toContain(call);
      expect(outside).not.toContain(call);
    }
  });
});
