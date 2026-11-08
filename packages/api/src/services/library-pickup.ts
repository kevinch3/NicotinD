import { existsSync } from 'node:fs';
import { createLogger } from '@nicotind/core';
import { MusicDirWatcher } from './music-dir-watcher.js';

const log = createLogger('library-pickup');

export interface LibraryPickupOptions {
  musicDir: string;
  reserved: ReadonlySet<string>;
  /** Watch the music dir for new files (local disks). */
  watch: boolean;
  /** Full sync every N minutes for network shares; 0 = off. */
  rescanMinutes: number;
  reconcileAlbumDirs: (albumDirs: string[]) => Promise<void>;
  runSync: () => Promise<void>;
}

/**
 * Starts the two ways new music reaches the library without a manual Sync
 * (#1740). The watcher reconciles just the touched albums within seconds; the
 * periodic sync, off by default so a spun-down disk is not woken on a timer, is
 * for network shares where inotify never sees a remote write.
 */
export function startLibraryPickup(opts: LibraryPickupOptions): { stop: () => void } {
  let watcher: MusicDirWatcher | null = null;
  if (opts.watch && existsSync(opts.musicDir)) {
    watcher = new MusicDirWatcher({
      musicDir: opts.musicDir,
      reserved: opts.reserved,
      onAlbums: opts.reconcileAlbumDirs,
      onRemoved: opts.runSync,
    });
    watcher.start();
  }
  let interval: ReturnType<typeof setInterval> | null = null;
  if (opts.rescanMinutes > 0) {
    interval = setInterval(() => void opts.runSync(), opts.rescanMinutes * 60_000);
    interval.unref();
    log.info({ minutes: opts.rescanMinutes }, 'periodic library sync on');
  }
  return {
    stop: () => {
      watcher?.stop();
      if (interval) clearInterval(interval);
    },
  };
}
