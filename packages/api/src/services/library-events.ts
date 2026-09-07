/**
 * Library events: the one place a library mutation announces itself, so an
 * open client can learn about it without polling or reloading.
 *
 * Emitted from SERVICES, never routes — the scanner, deletion, cover and
 * metadata mutations, the job store — so the MCP agent, a CLI script and an
 * HTTP route all emit the same way. Consumed by `GET /api/library/events`
 * (server-sent events; see routes/library-events.ts) and, through it, by the
 * web `LibraryEventsService`.
 *
 * Two properties the transport relies on:
 *
 * - **Coalescing.** Emits of one type inside a `COALESCE_MS` window are merged
 *   (ids unioned) before subscribers see them, so a 2,000-song scan is a
 *   handful of frames rather than 2,000. Types that carry a single id
 *   (`album.changed`, `artist.changed`, `job.changed`, `artwork.changed`) are
 *   coalesced per id instead: the last one in the window wins.
 * - **Replay.** Every delivered event gets a monotonic `seq`; the last
 *   `BUFFER_SIZE` are kept for `BUFFER_MS` so a reconnecting client can ask for
 *   everything since the last `seq` it saw. A `seq` older than the buffer is a
 *   gap, and the caller must resync rather than pretend.
 */
export type LibraryEvent =
  | { type: 'songs.landed'; songIds: string[]; albumIds: string[] }
  | { type: 'songs.deleted'; songIds: string[]; albumIds: string[] }
  | { type: 'album.changed'; albumId: string }
  | { type: 'artist.changed'; artistId: string }
  | { type: 'artwork.changed'; albumId: string; coverArt: string | null; version: number }
  | { type: 'job.changed'; jobId: string };

export interface StampedEvent {
  seq: number;
  at: number;
  event: LibraryEvent;
}

export const COALESCE_MS = 250;
export const BUFFER_SIZE = 500;
export const BUFFER_MS = 10 * 60_000;

export interface LibraryEvents {
  emit(event: LibraryEvent): void;
  on(fn: (e: StampedEvent) => void): () => void;
  /** Events after `seq`, or `null` when `seq` is older than the buffer (a gap). */
  since(seq: number): StampedEvent[] | null;
  /** The last delivered seq (0 when nothing has been delivered). */
  lastSeq(): number;
  /** Deliver anything still waiting in the coalescing window (tests, shutdown). */
  flush(): void;
}

function coalesceKey(e: LibraryEvent): string {
  switch (e.type) {
    case 'songs.landed':
    case 'songs.deleted':
      return e.type;
    case 'album.changed':
    case 'artwork.changed':
      return `${e.type}:${e.albumId}`;
    case 'artist.changed':
      return `${e.type}:${e.artistId}`;
    case 'job.changed':
      return `${e.type}:${e.jobId}`;
  }
}

function merge(a: LibraryEvent, b: LibraryEvent): LibraryEvent {
  if ((a.type === 'songs.landed' || a.type === 'songs.deleted') && a.type === b.type) {
    return {
      type: a.type,
      songIds: [...new Set([...a.songIds, ...b.songIds])],
      albumIds: [...new Set([...a.albumIds, ...b.albumIds])],
    };
  }
  return b;
}

export function createLibraryEvents(
  opts: {
    coalesceMs?: number;
    now?: () => number;
    schedule?: (fn: () => void, ms: number) => void;
  } = {},
): LibraryEvents {
  const coalesceMs = opts.coalesceMs ?? COALESCE_MS;
  const now = opts.now ?? (() => Date.now());
  const schedule = opts.schedule ?? ((fn, ms) => void setTimeout(fn, ms));
  const listeners = new Set<(e: StampedEvent) => void>();
  const buffer: StampedEvent[] = [];
  const pending = new Map<string, LibraryEvent>();
  let seq = 0;
  let timerArmed = false;

  const deliver = (event: LibraryEvent): void => {
    const stamped: StampedEvent = { seq: ++seq, at: now(), event };
    buffer.push(stamped);
    const cutoff = stamped.at - BUFFER_MS;
    while (buffer.length > BUFFER_SIZE || (buffer.length && buffer[0]!.at < cutoff)) buffer.shift();
    for (const fn of listeners) {
      try {
        fn(stamped);
      } catch {
        // A broken subscriber must not take the others down.
      }
    }
  };

  const flush = (): void => {
    timerArmed = false;
    const batch = [...pending.values()];
    pending.clear();
    for (const e of batch) deliver(e);
  };

  return {
    emit(event) {
      const key = coalesceKey(event);
      const prev = pending.get(key);
      pending.set(key, prev ? merge(prev, event) : event);
      if (!timerArmed) {
        timerArmed = true;
        schedule(flush, coalesceMs);
      }
    },
    on(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    since(after) {
      if (after >= seq) return [];
      const oldest = buffer[0]?.seq;
      // Everything after `after` must still be in the buffer: the first kept
      // seq has to be `after + 1` or earlier, otherwise something was dropped.
      if (oldest === undefined || oldest > after + 1) return null;
      return buffer.filter((e) => e.seq > after);
    },
    lastSeq: () => seq,
    flush,
  };
}

/** The process-wide bus every service emits on. */
export const libraryEvents: LibraryEvents = createLibraryEvents();
