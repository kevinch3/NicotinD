import { readdirSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { createLogger } from '@nicotind/core';
import { isHiddenFile, isReservedTopLevel } from './library-paths.js';

const log = createLogger('music-dir-watcher');

export interface MusicDirWatcherOptions {
  musicDir: string;
  /** Top-level staging names (downloads, unsorted) that are not library content. */
  reserved: ReadonlySet<string>;
  /** Album folders (absolute) that gained or changed files. */
  onAlbums: (albumDirs: string[]) => Promise<void>;
  /** Something was removed: only a full sync prunes an album with no audio left. */
  onRemoved: () => void | Promise<void>;
  /** Quiet period before reporting, so a copy in progress is reported once, finished. */
  quietMs?: number;
}

/**
 * Picks up music dropped into the library folder without a manual Sync (#1740).
 *
 * One non-recursive `fs.watch` per directory, not a single recursive one: Bun's
 * `{ recursive: true }` on Linux reports nothing inside a directory created
 * after the watch started, so a new album under an existing artist (the common
 * case) was invisible. A directory that appears gets its own watchers and is
 * walked, since files can land in it before the watcher attaches.
 *
 * Changes are batched until `quietMs` passes with no event, then reported as
 * album folders for the album-scoped reconcile. A removal asks for a full sync
 * instead. Staging dirs and hidden files (Syncthing temp files, `._` forks) are
 * skipped by the same `library-paths` rules every library walker uses. inotify
 * does not see changes made by another machine on a network share; the
 * periodic rescan (`libraryRescanMinutes`) covers that.
 */
export class MusicDirWatcher {
  private readonly watchers = new Map<string, FSWatcher>();
  private readonly dirty = new Set<string>();
  private removed = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private limitWarned = false;
  private stopped = false;
  private readonly quietMs: number;

  constructor(private readonly opts: MusicDirWatcherOptions) {
    this.quietMs = opts.quietMs ?? 3_000;
  }

  start(): void {
    this.addTree(this.opts.musicDir, false);
    log.info({ musicDir: this.opts.musicDir, dirs: this.watchers.size }, 'watching the music dir');
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    for (const w of this.watchers.values()) w.close();
    this.watchers.clear();
  }

  /** Whether `name` inside `dir` is something the library ignores. */
  private skipped(dir: string, name: string): boolean {
    if (isHiddenFile(name)) return true;
    return dir === this.opts.musicDir && isReservedTopLevel(name, this.opts.reserved);
  }

  /** Watch `dir` and everything under it; `markDirty` reports what is already there. */
  private addTree(dir: string, markDirty: boolean): void {
    if (this.stopped) return;
    this.watchDir(dir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // vanished meanwhile: the removal event covers it
    }
    for (const e of entries) {
      if (this.skipped(dir, e.name)) continue;
      if (e.isDirectory()) this.addTree(join(dir, e.name), markDirty);
      else if (markDirty) this.markDirty(dir);
    }
  }

  private watchDir(dir: string): void {
    if (this.watchers.has(dir)) return;
    try {
      const w = watch(dir, (_event, name) => this.onEvent(dir, name ? String(name) : null));
      w.on('error', () => this.unwatchTree(dir));
      this.watchers.set(dir, w);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOSPC' && !this.limitWarned) {
        this.limitWarned = true;
        log.warn(
          { watched: this.watchers.size },
          'inotify watch limit reached: newer folders are not watched. Raise ' +
            'fs.inotify.max_user_watches, or set NICOTIND_LIBRARY_RESCAN_MINUTES',
        );
      }
    }
  }

  private unwatchTree(dir: string): void {
    for (const [path, w] of this.watchers) {
      if (path === dir || path.startsWith(dir + sep)) {
        w.close();
        this.watchers.delete(path);
      }
    }
  }

  private onEvent(dir: string, name: string | null): void {
    if (this.stopped) return;
    if (name === null) {
      this.markDirty(dir);
      return;
    }
    if (this.skipped(dir, name)) return;
    const full = join(dir, name);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      // Gone: a deleted file or folder (or the old name of a rename).
      if (this.watchers.has(full)) this.unwatchTree(full);
      this.removed = true;
      this.schedule();
      return;
    }
    if (isDir) this.addTree(full, true);
    else this.markDirty(dir);
  }

  private markDirty(dir: string): void {
    if (dir === this.opts.musicDir) return; // loose files at the root are not an album
    this.dirty.add(dir);
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.quietMs);
  }

  private async flush(): Promise<void> {
    this.timer = null;
    const dirs = [...this.dirty];
    const removed = this.removed;
    this.dirty.clear();
    this.removed = false;
    try {
      if (removed) {
        log.info({ changed: dirs.length }, 'music dir: something was removed, running a sync');
        await this.opts.onRemoved();
      } else if (dirs.length > 0) {
        log.info(
          { albums: dirs.map((d) => relative(this.opts.musicDir, d)) },
          'music dir: new or changed files, reconciling their albums',
        );
        await this.opts.onAlbums(dirs);
      }
    } catch (err) {
      log.warn({ err }, 'music dir change could not be applied; the next sync will');
    }
  }
}
