import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { startLibraryPickup } from './library-pickup.js';

describe('startLibraryPickup (#1740)', () => {
  const stops: Array<() => void> = [];
  afterEach(() => {
    while (stops.length) stops.pop()!();
  });

  const base = (over: Partial<Parameters<typeof startLibraryPickup>[0]> = {}) => {
    const musicDir = mkdtempSync(join(tmpdir(), 'nicotind-pickup-'));
    stops.push(() => rmSync(musicDir, { recursive: true, force: true }));
    const reconcileAlbumDirs = mock(async (_dirs: string[]) => {});
    const runSync = mock(async () => {});
    const pickup = startLibraryPickup({
      musicDir,
      reserved: new Set(),
      watch: true,
      rescanMinutes: 0,
      reconcileAlbumDirs,
      runSync,
      ...over,
    });
    stops.push(pickup.stop);
    return { musicDir, reconcileAlbumDirs, runSync };
  };

  it('never syncs on a timer unless asked', async () => {
    const { runSync } = base();
    await Bun.sleep(50);
    expect(runSync).not.toHaveBeenCalled();
  });

  it('does not watch when the watcher is turned off', async () => {
    const { musicDir, reconcileAlbumDirs } = base({ watch: false });
    mkdirSync(join(musicDir, 'A', 'B'), { recursive: true });
    writeFileSync(join(musicDir, 'A', 'B', '1.flac'), 'x');
    await Bun.sleep(3_500);
    expect(reconcileAlbumDirs).not.toHaveBeenCalled();
  });

  it('skips a music dir that does not exist yet instead of throwing', () => {
    expect(() =>
      startLibraryPickup({
        musicDir: join(tmpdir(), 'nicotind-no-such-dir-xyz'),
        reserved: new Set(),
        watch: true,
        rescanMinutes: 0,
        reconcileAlbumDirs: async () => {},
        runSync: async () => {},
      }).stop(),
    ).not.toThrow();
  });
});
