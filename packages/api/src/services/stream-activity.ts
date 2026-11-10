/**
 * Which library files a listener is streaming right now, so a tag write that
 * rewrites a file can wait until nobody is reading it.
 *
 * A tag write replaces the file and shifts every audio byte (54 lines of
 * lyrics moved an Opus file's first audio page from byte 136 to 2,413). iOS
 * Safari reads a stream as many `Range` requests, so a rewrite mid-playback
 * hands it bytes from the new layout at offsets from the old one: noise, then
 * silence while the clock keeps running. The first play of a song fetches its
 * lyrics, which wrote the tag about a second into playback.
 * → docs/lyrics-options.md "The file tag waits for playback"
 */
import { resolve } from 'node:path';
import { createLogger } from '@nicotind/core';

const log = createLogger('stream-activity');

/** How long a file must go unrequested before a deferred write touches it. */
export const STREAM_IDLE_MS = 10 * 60_000;

export interface StreamActivity {
  noteStreamed(absPath: string): void;
  /** Run `write` now if `absPath` is idle, else once it has been idle for the window. */
  writeWhenIdle(absPath: string, write: () => Promise<unknown>): void;
  trackedCount(): number;
}

export function createStreamActivity(
  opts: {
    idleMs?: number;
    now?: () => number;
    setTimer?: (fn: () => void, ms: number) => void;
  } = {},
): StreamActivity {
  const idleMs = opts.idleMs ?? STREAM_IDLE_MS;
  const now = opts.now ?? Date.now;
  const setTimer =
    opts.setTimer ??
    ((fn: () => void, ms: number) => {
      setTimeout(fn, ms).unref?.();
    });
  const lastStreamed = new Map<string, number>();
  // Keyed by file: a later write for the same file replaces the earlier one,
  // and never cancels another file's.
  const pending = new Map<string, () => Promise<unknown>>();
  const armed = new Set<string>();

  const run = (absPath: string, write: () => Promise<unknown>) => {
    void write().catch((err: unknown) => log.warn({ err, absPath }, 'deferred tag write failed'));
  };

  const check = (absPath: string) => {
    armed.delete(absPath);
    const write = pending.get(absPath);
    if (!write) return;
    const last = lastStreamed.get(absPath);
    const wait = last === undefined ? 0 : last + idleMs - now();
    if (wait > 0) {
      armed.add(absPath);
      setTimer(() => check(absPath), wait);
      return;
    }
    pending.delete(absPath);
    run(absPath, write);
  };

  return {
    noteStreamed(path) {
      // Both sides key on the resolved path: the stream route and a tag writer
      // build it from the music dir in different ways.
      const absPath = resolve(path);
      const t = now();
      for (const [p, at] of lastStreamed) if (t - at > idleMs) lastStreamed.delete(p);
      lastStreamed.set(absPath, t);
    },
    writeWhenIdle(path, write) {
      const absPath = resolve(path);
      pending.set(absPath, write);
      if (!armed.has(absPath)) check(absPath);
    },
    trackedCount: () => lastStreamed.size,
  };
}

/** The process-wide instance the stream route feeds and tag writers consult. */
export const streamActivity = createStreamActivity();
