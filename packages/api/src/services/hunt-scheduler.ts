/**
 * One gate in front of the acquisition source, with priority lanes (#1945).
 *
 * Core ran four `HuntQueue`s against the same source: the copy picker, album
 * Get, track Get and auto-complete. Each ran one search at a time, but the four
 * ran side by side, so unattended auto-complete work competed for the source's
 * search lanes with someone's click (#1625). Every queue now takes its turn
 * here before it searches:
 *
 * - **Lanes, highest first:** `picker` (a person waiting on the copy picker),
 *   `get` (a one-click or bulk Get, album or track), `auto` (unattended
 *   re-sourcing of partials).
 * - **First in, first out within a lane.**
 * - **A running search is never interrupted.** Priority decides who goes next.
 * - **One number for the source's concurrency:** `concurrency`, here and nowhere
 *   else.
 */
export const HUNT_LANES = ['picker', 'get', 'auto'] as const;
export type HuntLane = (typeof HUNT_LANES)[number];

interface Waiter {
  lane: HuntLane;
  seq: number;
  grant: (release: () => void) => void;
}

export interface HuntTicket {
  /** Resolves with the release function once it is this caller's turn. */
  granted: Promise<() => void>;
  /** Give the place up before it is granted. False once it was granted. */
  cancel: () => boolean;
  /** Searches that will start before this one: those running, and waiters ahead. */
  ahead: () => number;
}

export class HuntScheduler {
  private readonly waiting: Waiter[] = [];
  private running = 0;
  private seq = 0;

  constructor(private readonly concurrency = 1) {}

  /** Ask for a turn in `lane`. */
  request(lane: HuntLane): HuntTicket {
    let grant!: (release: () => void) => void;
    const granted = new Promise<() => void>((resolve) => (grant = resolve));
    const waiter: Waiter = { lane, seq: this.seq++, grant };
    this.waiting.push(waiter);
    this.pump();
    return {
      granted,
      cancel: () => {
        const at = this.waiting.indexOf(waiter);
        if (at < 0) return false;
        this.waiting.splice(at, 1);
        return true;
      },
      ahead: () => {
        if (!this.waiting.includes(waiter)) return 0;
        return this.running + this.waiting.filter((w) => before(w, waiter)).length;
      },
    };
  }

  /** Searches running and waiting right now, per lane: for logs and diagnostics. */
  snapshot(): { running: number; waiting: Record<HuntLane, number> } {
    const waiting = { picker: 0, get: 0, auto: 0 };
    for (const w of this.waiting) waiting[w.lane]++;
    return { running: this.running, waiting };
  }

  private pump(): void {
    while (this.running < this.concurrency && this.waiting.length > 0) {
      let next = this.waiting[0]!;
      for (const w of this.waiting) if (before(w, next)) next = w;
      this.waiting.splice(this.waiting.indexOf(next), 1);
      this.running++;
      let released = false;
      next.grant(() => {
        if (released) return;
        released = true;
        this.running--;
        this.pump();
      });
    }
  }
}

/** Whether `a` runs before `b`: the higher lane first, then the earlier request. */
function before(a: Waiter, b: Waiter): boolean {
  if (a === b) return false;
  const lane = HUNT_LANES.indexOf(a.lane) - HUNT_LANES.indexOf(b.lane);
  return lane !== 0 ? lane < 0 : a.seq < b.seq;
}
