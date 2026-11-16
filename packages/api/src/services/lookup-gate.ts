/**
 * A limit on how many metadata lookups run at once (#757).
 *
 * `lookup_album_metadata` and `lookup_song_metadata` each fan out to about four
 * outside sources (Lidarr, MusicBrainz, Discogs, LRCLIB) inside the request.
 * Ten of them in parallel answered with a 502 from the edge on prod. Calls
 * beyond the limit wait their turn, first in, first out: a batch gets slower,
 * never wrong, and an agent needs no pacing rule of its own.
 */
export const LOOKUP_CONCURRENCY = 3;

/** The tools whose handler does that fan-out. */
export const GATED_LOOKUP_TOOLS: ReadonlySet<string> = new Set([
  'lookup_album_metadata',
  'lookup_song_metadata',
]);

export class LookupGate {
  private running = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(readonly size: number = LOOKUP_CONCURRENCY) {}

  /** Run `fn` once a place is free. The place is given back however `fn` ends. */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.size) await new Promise<void>((grant) => this.waiting.push(grant));
    else this.running++;
    try {
      return await fn();
    } finally {
      // Hand the place straight to the next waiter, so `running` never dips and
      // a caller arriving in between cannot jump the queue.
      const next = this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  snapshot(): { running: number; waiting: number } {
    return { running: this.running, waiting: this.waiting.length };
  }
}

/** One gate for the process: the outside sources are shared by every caller. */
export const lookupGate = new LookupGate();
