import { Injectable, signal, computed, effect, untracked } from '@angular/core';
import {
  DEFAULT_STRATEGY,
  isStrategyId,
  type LibraryFilter,
  type StrategyId,
} from '@nicotind/core';
import type { BufferedRange } from '../lib/buffered-ranges';
import { moveInList } from '../lib/move-in-list';

export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  artists?: Array<{ id: string; name: string; role: 'primary' | 'featuring' }>;
  album?: string;
  albumId?: string;
  coverArt?: string;
  duration?: number;
  bitRate?: number;
  genre?: string;
  bpm?: number;
  key?: string;
  /** Who put it in the queue. Radio-appended tracks are the ones a strategy
   *  change may throw away; a track the listener queued is never touched. */
  queuedBy?: 'radio' | 'user';
}

export interface PlayContext {
  type: 'album' | 'playlist' | 'adhoc' | 'saved-offline';
  id?: string;
  name?: string;
  originalOrder: Track[];
}

/**
 * A seek the user asked for that the media element could not satisfy yet —
 * the target sits past the region the browser can currently seek into.
 * PlayerComponent holds it and re-tries as data arrives; surfaces read it so
 * the seek bar shows where the user asked to be rather than where playback
 * still is. Keyed by track so a skip during the wait voids it.
 */
export interface PendingSeek {
  trackId: string;
  /** Absolute target position, in seconds. */
  time: number;
}

function isTrack(v: unknown): v is Track {
  return typeof v === 'object' && v !== null && typeof (v as Track).id === 'string';
}

function isPlayContext(v: unknown): v is PlayContext {
  return typeof v === 'object' && v !== null && Array.isArray((v as PlayContext).originalOrder);
}

/**
 * What a radio session is *about*, fixed when it starts (#1277).
 *
 * A song radio used to hand the provider whatever was playing, so after the
 * first fill every top-up was one hop from its predecessor — a walk, not a
 * station. The anchor is the seed for every top-up and the name in the Now
 * Playing labels; a filter radio needs none because `radioFilter` already is
 * one. `ids` is what the server takes as `seedIds` (it caps the list at 20);
 * `members` is the whole list, kept out of the answers.
 */
export type RadioAnchor =
  | { kind: 'song'; id: string; title: string }
  | { kind: 'list'; ids: string[]; members: string[]; name?: string };

const isStringArray = (v: unknown): v is string[] =>
  Array.isArray(v) && v.every((x) => typeof x === 'string');

export function isRadioAnchor(v: unknown): v is RadioAnchor {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Partial<RadioAnchor>;
  if (a.kind === 'song') return typeof a.id === 'string' && typeof a.title === 'string';
  if (a.kind === 'list') return isStringArray(a.ids) && isStringArray(a.members);
  return false;
}

/** The server takes at most this many `seedIds`. */
const LIST_ANCHOR_SEEDS = 20;

/**
 * How many ids a radio fetch may ask the server to keep out — mirrors
 * `MAX_EXCLUDE_IDS` in `packages/api/src/routes/radio.ts`. Persisted history
 * is held to the same length so the window survives a reload.
 */
export const RADIO_EXCLUDE_CAP = 200;

function songAnchor(track: Track): RadioAnchor {
  return { kind: 'song', id: track.id, title: track.title };
}

function listAnchor(seedIds: string[], memberIds: string[], name?: string): RadioAnchor {
  return {
    kind: 'list',
    ids: seedIds.slice(0, LIST_ANCHOR_SEEDS),
    members: memberIds.slice(0, RADIO_EXCLUDE_CAP),
    ...(name ? { name } : {}),
  };
}

function anchorKey(anchor: RadioAnchor | null): string {
  if (!anchor) return 'none';
  return anchor.kind === 'song' ? `song:${anchor.id}` : `list:${anchor.ids.join(',')}`;
}

export function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

/** Mark a track as radio-appended (see `Track.queuedBy`). */
function radioQueued(t: Track): Track {
  return { ...t, queuedBy: 'radio' };
}

// Fetches more tracks to keep the queue alive when Radio is on. Registered by a
// component with library access (PlayerService stays dependency-free).
export type RadioProvider = (seed: {
  currentTrack: Track | null;
  context: PlayContext | null;
  /** What the session is about — the seed of every top-up. Null for a filter radio. */
  anchor: RadioAnchor | null;
  /** The listener's current variety position, as a named strategy. */
  strategy: StrategyId;
  /**
   * How many tracks this call should return: the queue's shortfall against its
   * target, which after the first fill is usually 1. A provider that ignores it
   * and answers with a fixed batch still works — the extras are just kept.
   */
  count: number;
}) => Promise<Track[]>;

/**
 * How deep the radio queue is held when the server has not said otherwise.
 * Matches `DEFAULT_RADIO_SETTINGS.queueTarget`; the two are separate on purpose
 * — the client must still behave before the settings fetch lands, and on a
 * build talking to an older server that has no opinion at all.
 */
export const DEFAULT_RADIO_QUEUE_TARGET = 20;

// How long buffering must persist before surfaces show a spinner. HDD
// spin-up/seek (multi-second) is the target; cached tracks that start in
// <250ms must never flash a loader.
const BUFFERING_VISIBLE_DELAY_MS = 250;

@Injectable({ providedIn: 'root' })
export class PlayerService {
  private static readonly STORAGE_KEY = 'nicotind_player_state';

  readonly currentTrack = signal<Track | null>(null);
  readonly isPlaying = signal(false);
  readonly queue = signal<Track[]>([]);
  readonly history = signal<Track[]>([]);
  readonly shuffle = signal(false);
  readonly repeat = signal<'off' | 'all' | 'one'>('off');
  // Radio: when the queue runs low (and repeat is off), auto-append more tracks
  // from the library so playback never stops. Persisted across sessions.
  readonly radio = signal(false);
  // When radio was started from a filter ("happy rock", "120bpm+ danceable")
  // rather than a seed song, this holds that filter so auto-replenish keeps
  // pulling in-vibe tracks (via the radio provider) instead of re-seeding off
  // the current song. Null for seed radio / radio off. Persisted with `radio`.
  readonly radioFilter = signal<LibraryFilter | null>(null);
  // The song or list a radio was started from; every top-up is seeded from it
  // (see RadioAnchor). Null for a filter radio and when radio is off. A user
  // gesture clears it and the next top-up derives a fresh one. Persisted.
  readonly radioAnchor = signal<RadioAnchor | null>(null);
  // The variety position (docs/radio.md "Strategies"): which named recipe the
  // radio provider asks for. Remembered here across sessions and, per user, on
  // the server; the chip in Now Playing is its control.
  readonly radioStrategy = signal<StrategyId>(DEFAULT_STRATEGY);
  /**
   * The depth radio holds the queue at. Radio used to drain to two tracks and
   * then drop a batch in, which read as a stall: the "up next" list emptied out
   * in front of the listener and refilled in a lump (#1263). It now tops up to
   * this many and replaces each track as it is consumed, so the queue looks the
   * same depth all the way down. Admin-owned (`/api/settings/radio`), pushed in
   * by `RadioSourceService`; the default stands until that lands.
   */
  readonly radioQueueTarget = signal(DEFAULT_RADIO_QUEUE_TARGET);
  readonly context = signal<PlayContext | null>(null);
  readonly nowPlayingOpen = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly seekTo = signal<number | null>(null);
  // A seek waiting on data (see PendingSeek). Written only by PlayerComponent's
  // seek applier; read by the transport surfaces so the position they render
  // follows the user's intent while the element catches up.
  readonly pendingSeek = signal<PendingSeek | null>(null);
  // Karaoke vocal mute: when true, streams include ?vocals=off for center-channel
  // cancellation. Persists across tracks until toggled off or player cleared.
  readonly vocalsMuted = signal(false);

  // Audio is loading/stalled on the active device (set by PlayerComponent from
  // native <audio> events). `bufferingVisible` is the render-safe view: it only
  // turns on after BUFFERING_VISIBLE_DELAY_MS, but turns off instantly.
  readonly buffering = signal(false);
  readonly bufferingVisible = signal(false);
  // Snapshot of audio.buffered (seconds) for the seek bar's loaded-so-far band.
  readonly bufferedRanges = signal<BufferedRange[]>([]);
  private bufferingVisibleTimer: ReturnType<typeof setTimeout> | null = null;
  // Recovery state: when the browser fires a `ended` event we believe is false
  // (currentTime nowhere near the known duration), the player pauses and waits
  // for a sane `durationchange` before resuming. `normal` = no recovery in
  // progress; `awaiting-duration` = paused, listening for a real duration.
  readonly recoveryState = signal<'normal' | 'awaiting-duration'>('normal');

  // Set by restoreState(); consumed by PlayerComponent.onDuration after audio is ready.
  restoredTime: number | null = null;

  constructor() {
    effect(() => {
      const currentTrack = this.currentTrack();
      if (currentTrack === null) {
        localStorage.removeItem(PlayerService.STORAGE_KEY);
        return;
      }
      const snapshot = this.snapshot(
        currentTrack,
        untracked(() => this.currentTime()),
      );
      try {
        localStorage.setItem(PlayerService.STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        /* quota exceeded */
      }
    });

    // Radio: whenever the queue sits below its target depth (and we're not
    // repeating), pull the shortfall from the library so the queue stays the
    // same length as it is consumed. Reads queue()/radio()/radioQueueTarget()
    // so it re-runs on any drain (next track, manual removal) and on an admin
    // raising the depth; the actual fetch + queue append happens async
    // (untracked) so it never loops on its own write.
    effect(() => {
      const queueLen = this.queue().length;
      const radioOn = this.radio();
      const target = this.radioQueueTarget();
      if (!radioOn || queueLen >= target) return;
      const hasCurrent = untracked(() => this.currentTrack()) !== null;
      const repeating = untracked(() => this.repeat()) !== 'off';
      if (hasCurrent && !repeating) untracked(() => void this.replenishRadio());
    });

    const capturePosition = () => {
      const currentTrack = this.currentTrack();
      if (currentTrack === null) return;
      try {
        const snapshot = this.snapshot(currentTrack, this.currentTime());
        localStorage.setItem(PlayerService.STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener('pagehide', capturePosition, { passive: true });
    window.addEventListener('freeze', capturePosition, { passive: true });
    window.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'hidden') capturePosition();
      },
      { passive: true },
    );
  }

  /** The one shape both persistence paths write, so a field cannot land in one and not the other. */
  private snapshot(currentTrack: Track, currentTime: number) {
    return {
      currentTrack,
      queue: this.queue(),
      history: this.history().slice(-RADIO_EXCLUDE_CAP),
      shuffle: this.shuffle(),
      repeat: this.repeat(),
      radio: this.radio(),
      radioFilter: this.radioFilter(),
      radioAnchor: this.radioAnchor(),
      radioStrategy: this.radioStrategy(),
      context: this.context(),
      currentTime,
      wasPlaying: this.isPlaying(),
    };
  }

  restoreState(): void {
    try {
      const raw = localStorage.getItem(PlayerService.STORAGE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as Record<string, unknown>;
      if (isTrack(state['currentTrack'])) this.currentTrack.set(state['currentTrack']);
      // `wasPlaying` is deliberately ignored: restore never resumes playback.
      // Everything else below is restored, so you come back to your queue and
      // seek position — just paused. Browsers block gesture-less playback anyway,
      // and a page load that starts making noise is a bad surprise.
      if (Array.isArray(state['queue'])) this.queue.set(state['queue'] as Track[]);
      if (Array.isArray(state['history'])) this.history.set(state['history'] as Track[]);
      if (state['shuffle'] != null) this.shuffle.set(Boolean(state['shuffle']));
      if (state['repeat'] != null) this.repeat.set(state['repeat'] as 'off' | 'all' | 'one');
      if (state['radio'] != null) this.radio.set(Boolean(state['radio']));
      const rf = state['radioFilter'];
      this.radioFilter.set(rf && typeof rf === 'object' ? (rf as LibraryFilter) : null);
      const ra = state['radioAnchor'];
      this.radioAnchor.set(isRadioAnchor(ra) ? ra : null);
      if (isStrategyId(state['radioStrategy'])) this.radioStrategy.set(state['radioStrategy']);
      if (isPlayContext(state['context'])) this.context.set(state['context']);
      if (typeof state['currentTime'] === 'number' && state['currentTime'] > 1) {
        this.restoredTime = state['currentTime'];
      }
    } catch {
      localStorage.removeItem(PlayerService.STORAGE_KEY);
    }
  }

  /** Queue-untouched primitive — user gestures use playSingle/playWithContext. */
  play(track: Track): void {
    this.currentTrack.set(track);
    this.isPlaying.set(true);
  }

  /** Play a context-less click: replaces the queue rather than inheriting it. */
  playSingle(track: Track): void {
    this.queue.set([]);
    this.history.set([]);
    this.context.set(null);
    this.radioAnchor.set(null); // a gesture: the next top-up is about this song
    this.play(track);
  }

  /** Play queue[index], consuming everything before it into history. */
  jumpToQueueIndex(index: number): void {
    const queue = this.queue();
    if (index < 0 || index >= queue.length) return;
    const current = this.currentTrack();
    this.history.set([...this.history(), ...(current ? [current] : []), ...queue.slice(0, index)]);
    this.queue.set(queue.slice(index + 1));
    this.play(queue[index]);
  }

  pause(): void {
    this.isPlaying.set(false);
  }

  resume(): void {
    this.isPlaying.set(true);
  }

  addToQueue(track: Track): void {
    this.queue.update((q) => [...q, track]);
  }

  /** Insert a track to play immediately after the current one. */
  queueNext(track: Track): void {
    this.queue.update((q) => [track, ...q]);
  }

  /** Start radio about a specific song: play it, anchor the session on it, and
   * enable radio. Clears any filter "vibe". */
  startRadio(track: Track): void {
    this.radioFilter.set(null);
    // A leftover queue would play out before radio ever kicked in.
    this.playSingle(track);
    this.radioAnchor.set(songAnchor(track));
    if (!this.radio()) this.toggleRadio();
  }

  /** Start radio from a filter "vibe" (mood/genre/bpm): play the first track,
   * queue the rest, and remember the filter so auto-replenish stays in-vibe.
   * `tracks` are already filter-scored by the caller (LibraryApiService). */
  startRadioWithFilter(tracks: Track[], filter: LibraryFilter): void {
    if (tracks.length === 0) return;
    const [first, ...rest] = tracks;
    this.radioFilter.set(filter);
    this.radioAnchor.set(null);
    this.context.set(null);
    this.play(first);
    this.queue.set(rest.map(radioQueued));
    // Set directly (not toggleRadio) — we already loaded a queue, so an eager
    // replenish would be wasteful; the drain effect handles later top-ups.
    this.radio.set(true);
  }

  /** Start radio from a prepared track list (e.g. a tastemaker blend): play the
   * first, queue the rest, radio on. Clears any filter "vibe". With `list` the
   * session stays about that list (the server's `seedIds` lane); without it,
   * about the first track. */
  startRadioWithTracks(
    tracks: Track[],
    list?: { seedIds: string[]; memberIds?: string[]; name?: string },
  ): void {
    if (tracks.length === 0) return;
    const [first, ...rest] = tracks;
    this.radioFilter.set(null);
    this.radioAnchor.set(
      list
        ? listAnchor(list.seedIds, list.memberIds ?? list.seedIds, list.name)
        : songAnchor(first),
    );
    this.context.set(null);
    this.play(first);
    this.queue.set(rest.map(radioQueued));
    // Direct set, not toggleRadio — the queue is already loaded (see above).
    this.radio.set(true);
  }

  playNext(): void {
    const repeat = this.repeat();
    const currentTrack = this.currentTrack();

    // repeat one: signal replay (Player component handles audio.currentTime = 0)
    if (repeat === 'one') {
      this.currentTrack.set(currentTrack ? { ...currentTrack } : null);
      this.isPlaying.set(true);
      return;
    }

    const newHistory = currentTrack ? [...this.history(), currentTrack] : this.history();
    const queue = this.queue();
    const context = this.context();
    const shuffle = this.shuffle();

    if (queue.length > 0) {
      const [next, ...rest] = queue;
      this.currentTrack.set(next);
      this.isPlaying.set(true);
      this.queue.set(rest);
      this.history.set(newHistory);
    } else if (repeat === 'all' && context) {
      // Reload from context
      const reloaded = shuffle ? shuffleArray(context.originalOrder) : [...context.originalOrder];
      const [first, ...rest] = reloaded;
      this.currentTrack.set(first);
      this.isPlaying.set(true);
      this.queue.set(rest);
      this.history.set([]);
    } else {
      // End of queue (no repeat/radio): keep the last track loaded but paused.
      // Clearing it would hide the mini-player and wipe the persisted session —
      // on mobile the user would have to start playback again just to get the
      // player chrome back. The track stays current, so it does NOT move into
      // history. (play() on the ended <audio> element restarts it from 0.)
      this.isPlaying.set(false);
    }
  }

  playPrev(): void {
    const history = this.history();
    const currentTrack = this.currentTrack();
    const queue = this.queue();

    if (history.length > 0) {
      const newHistory = [...history];
      const prev = newHistory.pop()!;
      const newQueue = currentTrack ? [currentTrack, ...queue] : queue;
      this.currentTrack.set(prev);
      this.isPlaying.set(true);
      this.history.set(newHistory);
      this.queue.set(newQueue);
    }
    // If no history, no-op — Player component handles the >3s restart
  }

  clear(): void {
    this.currentTrack.set(null);
    this.isPlaying.set(false);
    this.queue.set([]);
    this.history.set([]);
    this.context.set(null);
    this.currentTime.set(0);
    this.duration.set(0);
    this.seekTo.set(null);
    this.pendingSeek.set(null);
    this.vocalsMuted.set(false);
    this.setBuffering(false);
    this.bufferedRanges.set([]);
    localStorage.removeItem(PlayerService.STORAGE_KEY);
  }

  toggleShuffle(): void {
    const shuffle = this.shuffle();
    const queue = this.queue();
    const currentTrack = this.currentTrack();
    const context = this.context();

    if (!shuffle) {
      // Turning ON: save original order, then shuffle queue
      const allTracks = currentTrack ? [currentTrack, ...queue] : [...queue];
      const ctx = context ?? {
        type: 'adhoc' as const,
        originalOrder: allTracks,
      };
      if (!context) {
        // Auto-create adhoc context
        this.context.set({ ...ctx, originalOrder: allTracks });
      } else {
        // Update original order to include current state
        this.context.set({ ...context, originalOrder: allTracks });
      }
      this.shuffle.set(true);
      this.queue.set(shuffleArray(queue));
    } else {
      // Turning OFF: restore original order relative to current track
      if (context) {
        const currentId = currentTrack?.id;
        const original = context.originalOrder;
        const currentIdx = original.findIndex((t) => t.id === currentId);
        const restored = currentIdx >= 0 ? original.slice(currentIdx + 1) : [...original];
        this.shuffle.set(false);
        this.queue.set(restored);
      } else {
        this.shuffle.set(false);
      }
    }
  }

  cycleRepeat(): void {
    const current = this.repeat();
    const next = current === 'off' ? 'all' : current === 'all' ? 'one' : 'off';
    this.repeat.set(next);
  }

  private radioProvider: RadioProvider | null = null;
  private replenishing = false;
  /**
   * The anchor + playing track a replenish already came back empty-handed for.
   *
   * Topping up to a depth means the effect re-fires on every append, so a
   * library with nothing left to offer would be re-asked on every single queue
   * mutation for as long as radio stayed on. The latch holds that off until
   * something that could change the answer moves — the next track (the
   * exclude window moved), a new anchor, a new strategy, or radio being turned
   * on again.
   */
  private radioStarvedSeed: string | null = null;

  /** Stands in for "no seed at all" in the starved latch, which a real id can never be. */
  private static readonly NO_RADIO_SEED = '\u0000no-seed';

  /** Register the source of "more tracks" for Radio (library access lives in a component). */
  setRadioProvider(provider: RadioProvider): void {
    this.radioProvider = provider;
  }

  toggleRadio(): void {
    this.radio.update((r) => !r);
    // Turning it on with a low queue should fill immediately, not wait for a drain.
    if (this.radio()) {
      this.radioStarvedSeed = null;
      untracked(() => void this.replenishRadio());
    } else {
      // Turning radio off ends the session: the filter "vibe" and the anchor.
      this.radioFilter.set(null);
      this.radioAnchor.set(null);
    }
  }

  /**
   * What a session with no anchor yet is about: the album or playlist it grew
   * out of (the whole list, not the queue — that shrinks as it plays and holds
   * the radio tail), else the playing track. Runs when radio is turned on over
   * an existing queue, after a gesture cleared the anchor, and once for a
   * session remembered by a build that had no anchor to remember.
   */
  private deriveAnchor(): RadioAnchor | null {
    const context = this.context();
    if (context && (context.type === 'album' || context.type === 'playlist')) {
      const ids = context.originalOrder.map((t) => t.id);
      if (ids.length) return listAnchor(ids, ids, context.name);
    }
    const current = this.currentTrack();
    return current ? songAnchor(current) : null;
  }

  /**
   * What a top-up asks the server to keep out, in the order that matters when
   * the cap cuts it: what is playing, what is queued, the anchored list's own
   * members, then history newest first. `wide` is the normal pass; the narrow
   * one drops history so a session that has heard everything is served its
   * repeats oldest-first (the server demotes recent plays) instead of ending.
   */
  radioExcludeIds(wide: boolean): string[] {
    const anchor = this.radioAnchor();
    const ids = [
      this.currentTrack()?.id,
      ...this.queue().map((t) => t.id),
      ...(anchor?.kind === 'list' ? anchor.members : []),
      ...(wide ? [...this.history()].reverse().map((t) => t.id) : []),
    ].filter((id): id is string => !!id);
    return [...new Set(ids)].slice(0, RADIO_EXCLUDE_CAP);
  }

  /**
   * Turn radio on if it is not already, without the toggle's off branch.
   *
   * A TV build calls this at shell start: its five screens carry no radio
   * control (the toggle lives in the phone transport and the radio chip), so a
   * remembered `radio = false` could never be undone from the couch and every
   * queue ended in silence (#1127). Idempotent — safe on every start, and it
   * leaves an existing filter "vibe" alone.
   */
  ensureRadioOn(): void {
    if (this.radio()) return;
    this.radio.set(true);
    this.radioStarvedSeed = null;
    untracked(() => void this.replenishRadio());
  }

  /**
   * Move the variety position. Steers now: the radio-appended tail of the queue
   * (never a track the listener queued) is replaced from the new strategy on
   * the next fetch, which fires immediately when radio is on.
   */
  setRadioStrategy(strategy: StrategyId): void {
    if (this.radioStrategy() === strategy) return;
    this.radioStrategy.set(strategy);
    if (!this.radio()) return;
    // A new recipe is a new answer: whatever the old one had run out of, this
    // one has not been asked yet.
    this.radioStarvedSeed = null;
    this.queue.update((q) => q.filter((t) => t.queuedBy !== 'radio'));
    untracked(() => void this.replenishRadio());
  }

  toggleVocalMute(): void {
    this.vocalsMuted.update((v) => !v);
  }

  /**
   * Top the queue back up to its target depth with fresh library tracks,
   * skipping anything already lined up.
   *
   * It asks for exactly the shortfall, which after the first fill is normally
   * one track — the replacement for the one just played. A round that adds
   * something short of the target leaves the queue below it, so the effect
   * fires again and the next round asks for what is still missing; a round
   * that adds nothing latches instead of spinning (`radioStarvedSeed`).
   */
  private async replenishRadio(): Promise<void> {
    if (!this.radioProvider || this.replenishing) return;
    const deficit = this.radioQueueTarget() - this.queue().length;
    if (deficit <= 0) return;
    if (!this.radioFilter() && !this.radioAnchor()) this.radioAnchor.set(this.deriveAnchor());
    const anchor = this.radioAnchor();
    // Keyed on the anchor *and* the playing track: a starved session is
    // re-asked once per track (the exclude window has moved), never re-seeded.
    const seed = `${this.radioFilter() ? 'filter' : anchorKey(anchor)}|${
      this.currentTrack()?.id ?? PlayerService.NO_RADIO_SEED
    }`;
    if (this.radioStarvedSeed === seed) return;
    this.replenishing = true;
    try {
      const more = await this.radioProvider({
        currentTrack: this.currentTrack(),
        context: this.context(),
        anchor,
        strategy: this.radioStrategy(),
        count: deficit,
      });
      // Only what is playing or queued is off limits here: the provider may
      // have chosen to serve a repeat from history on purpose (see
      // radioExcludeIds), and dropping it would latch the session instead.
      const seen = new Set<string>([
        this.currentTrack()?.id ?? '',
        ...this.queue().map((t) => t.id),
      ]);
      const fresh = more.filter((t) => t.id && !seen.has(t.id)).map(radioQueued);
      if (fresh.length) {
        this.radioStarvedSeed = null;
        this.queue.update((q) => [...q, ...fresh]);
      } else {
        this.radioStarvedSeed = seed;
      }
    } catch {
      // Non-fatal — radio simply doesn't extend this time. Deliberately not
      // latched: a failed fetch says nothing about whether tracks exist, and
      // the next drain is the retry.
    } finally {
      this.replenishing = false;
    }
  }

  playWithContext(
    tracks: Track[],
    startIndex: number,
    contextInfo?: {
      type: PlayContext['type'];
      id?: string;
      name?: string;
    },
  ): void {
    const shuffle = this.shuffle();
    const current = tracks[startIndex];
    const remaining = [...tracks.slice(0, startIndex), ...tracks.slice(startIndex + 1)];
    const queue = shuffle ? shuffleArray(remaining) : tracks.slice(startIndex + 1);

    this.currentTrack.set(current);
    this.isPlaying.set(true);
    this.queue.set(queue);
    this.history.set([]);
    this.radioAnchor.set(null); // a gesture: the next top-up is about this list
    this.context.set({
      type: contextInfo?.type ?? 'adhoc',
      id: contextInfo?.id,
      name: contextInfo?.name,
      originalOrder: tracks,
    });
  }

  removeFromQueue(index: number): void {
    this.queue.update((q) => q.filter((_, i) => i !== index));
  }

  clearQueue(): void {
    this.queue.set([]);
  }

  moveInQueue(fromIndex: number, toIndex: number): void {
    if (fromIndex === toIndex) return;
    this.queue.update((q) => moveInList(q, fromIndex, toIndex));
  }

  setNowPlayingOpen(open: boolean): void {
    this.nowPlayingOpen.set(open);
  }

  setCurrentTime(time: number): void {
    this.currentTime.set(time);
  }

  setDuration(d: number): void {
    this.duration.set(d);
  }

  setCurrentTrackMetadata(track: Track): void {
    this.currentTrack.set(track);
  }

  seek(time: number): void {
    this.seekTo.set(time);
  }

  clearSeek(): void {
    this.seekTo.set(null);
  }

  setBuffering(value: boolean): void {
    this.buffering.set(value);
    if (value) {
      // untracked: callers include PlayerComponent's track-load effect. A plain
      // bufferingVisible() read here would register it as that effect's
      // dependency, so the 250ms spinner timer firing would re-run the effect,
      // re-assign audio.src and abort the in-flight load — endlessly, whenever
      // a stream's first byte takes longer than the spinner delay.
      if (this.bufferingVisibleTimer !== null || untracked(() => this.bufferingVisible())) return;
      this.bufferingVisibleTimer = setTimeout(() => {
        this.bufferingVisibleTimer = null;
        if (this.buffering()) this.bufferingVisible.set(true);
      }, BUFFERING_VISIBLE_DELAY_MS);
    } else {
      if (this.bufferingVisibleTimer !== null) {
        clearTimeout(this.bufferingVisibleTimer);
        this.bufferingVisibleTimer = null;
      }
      this.bufferingVisible.set(false);
    }
  }

  setBufferedRanges(ranges: BufferedRange[]): void {
    this.bufferedRanges.set(ranges);
  }
}
