import { AsyncLocalStorage } from 'node:async_hooks';
import { availableParallelism } from 'node:os';

/**
 * One process-wide cap on concurrent ffmpeg/ffprobe children (#1312). Every
 * ffmpeg user used to cap only itself — the organizer pool, enrichment, stream
 * transcodes, waveform decodes — so together they could oversubscribe the host.
 *
 * `interactive` work (a stream transcode or waveform a listener is waiting on)
 * never queues behind `batch` work: batch may hold at most `size - 1` slots, so
 * one is always free for interactive, and a freed slot goes to a waiting
 * interactive caller before any batch one. See docs/configuration.md.
 */
export type FfmpegPriority = 'interactive' | 'batch';

interface Held {
  released: boolean;
}

interface Waiter {
  priority: FfmpegPriority;
  grant: () => void;
}

export class FfmpegSlots {
  private active = 0;
  private activeBatch = 0;
  private readonly interactiveQueue: Waiter[] = [];
  private readonly batchQueue: Waiter[] = [];
  // Re-entrancy: code running inside a slot (a tag write that re-attaches a
  // cover, a transcode's output probe) spawns its follow-up child under the
  // slot it already holds instead of waiting for a second one — otherwise
  // `size` holders each waiting for a nested slot would deadlock.
  private readonly held = new AsyncLocalStorage<Held>();

  constructor(readonly size: number) {
    if (!Number.isInteger(size) || size < 2)
      throw new Error(`ffmpeg slots must be >= 2, got ${size}`);
  }

  /**
   * Run `fn` while holding a slot; the slot is released when its promise
   * settles. An uncontended call starts `fn` synchronously, as a bare spawn did.
   */
  run<T>(priority: FfmpegPriority, fn: () => Promise<T>): Promise<T> {
    const current = this.held.getStore();
    if (current && !current.released) return fn();
    const queue = priority === 'interactive' ? this.interactiveQueue : this.batchQueue;
    // A queued waiter keeps a new caller of its class from jumping it.
    if (queue.length === 0 && this.canStart(priority)) {
      this.take(priority);
      return this.runHeld(priority, fn);
    }
    return new Promise<void>((grant) => queue.push({ priority, grant })).then(() =>
      this.runHeld(priority, fn),
    );
  }

  private runHeld<T>(priority: FfmpegPriority, fn: () => Promise<T>): Promise<T> {
    const token: Held = { released: false };
    const done = () => {
      token.released = true;
      this.release(priority);
    };
    let work: Promise<T>;
    try {
      work = this.held.run(token, fn);
    } catch (err) {
      done();
      return Promise.reject(err);
    }
    return work.finally(done);
  }

  stats(): { active: number; activeBatch: number; waiting: number } {
    return {
      active: this.active,
      activeBatch: this.activeBatch,
      waiting: this.interactiveQueue.length + this.batchQueue.length,
    };
  }

  private canStart(priority: FfmpegPriority): boolean {
    if (this.active >= this.size) return false;
    return priority === 'interactive' || this.activeBatch < this.size - 1;
  }

  private take(priority: FfmpegPriority): void {
    this.active++;
    if (priority === 'batch') this.activeBatch++;
  }

  private release(priority: FfmpegPriority): void {
    this.active--;
    if (priority === 'batch') this.activeBatch--;
    while (this.interactiveQueue.length > 0 && this.canStart('interactive')) {
      this.grant(this.interactiveQueue.shift()!);
    }
    while (this.batchQueue.length > 0 && this.canStart('batch')) {
      this.grant(this.batchQueue.shift()!);
    }
  }

  private grant(w: Waiter): void {
    this.take(w.priority);
    w.grant();
  }
}

/** `NICOTIND_FFMPEG_SLOTS` when set to an integer >= 2, else the core count (min 2). */
export function resolveFfmpegSlotCount(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.NICOTIND_FFMPEG_SLOTS?.trim());
  if (Number.isInteger(raw) && raw >= 2) return raw;
  return Math.max(2, availableParallelism());
}

export const ffmpegSlots = new FfmpegSlots(resolveFfmpegSlotCount());

/** Hold one of the process-wide ffmpeg slots for the life of `fn`. */
export function withFfmpegSlot<T>(priority: FfmpegPriority, fn: () => Promise<T>): Promise<T> {
  return ffmpegSlots.run(priority, fn);
}
