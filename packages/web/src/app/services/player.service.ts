import { Injectable, signal, computed, effect, untracked } from '@angular/core';
import type { LibraryFilter } from '@nicotind/core';
import type { BufferedRange } from '../lib/buffered-ranges';

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
}

export interface PlayContext {
  type: 'album' | 'playlist' | 'adhoc' | 'saved-offline';
  id?: string;
  name?: string;
  originalOrder: Track[];
}

function isTrack(v: unknown): v is Track {
  return typeof v === 'object' && v !== null && typeof (v as Track).id === 'string';
}

function isPlayContext(v: unknown): v is PlayContext {
  return typeof v === 'object' && v !== null && Array.isArray((v as PlayContext).originalOrder);
}

export function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Fetches more tracks to keep the queue alive when Radio is on. Registered by a
// component with library access (PlayerService stays dependency-free).
export type RadioProvider = (seed: {
  currentTrack: Track | null;
  context: PlayContext | null;
}) => Promise<Track[]>;

// Replenish the queue once it drops to this many remaining tracks.
const RADIO_MIN_QUEUE = 2;

// A failed or empty replenish while the queue is still low retries after this
// long. Without it, a queue that never changes again (last tracks played out)
// never re-triggers the drain effect, dead-ending radio until the user toggles.
const RADIO_RETRY_MS = 30_000;

// Consecutive failed/empty replenishes before radio stops retrying. A
// successful append — or toggling radio — resets the count.
const RADIO_MAX_RETRIES = 3;

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
  // Radio: when the queue runs low, auto-append more tracks from the library so
  // playback never stops — regardless of repeat (radio wins while it's on).
  // Persisted across sessions.
  readonly radio = signal(false);
  // When radio was started from a filter ("happy rock", "120bpm+ danceable")
  // rather than a seed song, this holds that filter so auto-replenish keeps
  // pulling in-vibe tracks (via the radio provider) instead of re-seeding off
  // the current song. Null for seed radio / radio off. Persisted with `radio`.
  readonly radioFilter = signal<LibraryFilter | null>(null);
  readonly context = signal<PlayContext | null>(null);
  readonly nowPlayingOpen = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly seekTo = signal<number | null>(null);
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
  // Captured during restoreState(); consumed (once) by maybeResumeAutoplay
  // after /me resolves so the per-user autoplay_on_load setting can gate it.
  private wasPlayingRestored = false;

  constructor() {
    effect(() => {
      const currentTrack = this.currentTrack();
      if (currentTrack === null) {
        localStorage.removeItem(PlayerService.STORAGE_KEY);
        return;
      }
      const snapshot = {
        currentTrack,
        queue: this.queue(),
        history: this.history().slice(-50),
        shuffle: this.shuffle(),
        repeat: this.repeat(),
        radio: this.radio(),
        radioFilter: this.radioFilter(),
        context: this.context(),
        currentTime: untracked(() => this.currentTime()),
        wasPlaying: this.isPlaying(),
      };
      try {
        localStorage.setItem(PlayerService.STORAGE_KEY, JSON.stringify(snapshot));
      } catch {
        /* quota exceeded */
      }
    });

    // Radio trigger: re-runs on any queue write (drain, manual removal), on the
    // radio toggle itself (eager fill on turn-on), and on the bounded retry
    // nonce. Deliberately trigger-only — every guard lives in replenishRadio()
    // so all entry points share one decision path (a per-caller guard fork is
    // how the repeat-guard asymmetry bug shipped: the effect required
    // repeat==='off' while toggleRadio's eager fill didn't, so radio stalled
    // after one batch whenever repeat was on). The fetch + append happen async
    // (untracked) so the effect never loops on its own write.
    effect(() => {
      this.queue();
      this.radio();
      this.radioRetryNonce();
      untracked(() => void this.replenishRadio());
    });

    const capturePosition = () => {
      const currentTrack = this.currentTrack();
      if (currentTrack === null) return;
      try {
        const snapshot = {
          currentTrack,
          queue: this.queue(),
          history: this.history().slice(-50),
          shuffle: this.shuffle(),
          repeat: this.repeat(),
          radio: this.radio(),
          radioFilter: this.radioFilter(),
          context: this.context(),
          currentTime: this.currentTime(),
          wasPlaying: this.isPlaying(),
        };
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

  restoreState(): void {
    try {
      const raw = localStorage.getItem(PlayerService.STORAGE_KEY);
      if (!raw) return;
      const state = JSON.parse(raw) as Record<string, unknown>;
      if (isTrack(state['currentTrack'])) this.currentTrack.set(state['currentTrack']);
      // The autoplay decision is deferred until /me lands — only then do we know
      // the per-user autoplay_on_load preference. Capture here; maybeResumeAutoplay
      // runs the boolean through that pref to decide whether to resume.
      if (state['wasPlaying']) this.wasPlayingRestored = true;
      if (Array.isArray(state['queue'])) this.queue.set(state['queue'] as Track[]);
      if (Array.isArray(state['history'])) this.history.set(state['history'] as Track[]);
      if (state['shuffle'] != null) this.shuffle.set(Boolean(state['shuffle']));
      if (state['repeat'] != null) this.repeat.set(state['repeat'] as 'off' | 'all' | 'one');
      if (state['radio'] != null) this.radio.set(Boolean(state['radio']));
      const rf = state['radioFilter'];
      this.radioFilter.set(rf && typeof rf === 'object' ? (rf as LibraryFilter) : null);
      if (isPlayContext(state['context'])) this.context.set(state['context']);
      if (typeof state['currentTime'] === 'number' && state['currentTime'] > 1) {
        this.restoredTime = state['currentTime'];
      }
    } catch {
      localStorage.removeItem(PlayerService.STORAGE_KEY);
    }
  }

  /**
   * Called by app.config.ts after GET /api/auth/me resolves. Resumes a previously
   * playing session only when the per-user `autoplay_on_load` setting is enabled.
   * One-shot: a second call (e.g. after the user pauses) must not start playback
   * — the capture is cleared either way so it can't replay later.
   */
  maybeResumeAutoplay(enabled: boolean): void {
    const captured = this.wasPlayingRestored;
    this.wasPlayingRestored = false;
    if (enabled && captured && !this.isPlaying()) {
      this.isPlaying.set(true);
    }
  }

  /** Queue-untouched primitive — user gestures use playSingle/playWithContext. */
  play(track: Track): void {
    this.radioResumePending = false;
    this.currentTrack.set(track);
    this.isPlaying.set(true);
  }

  /** Play a context-less click: replaces the queue rather than inheriting it. */
  playSingle(track: Track): void {
    this.queue.set([]);
    this.history.set([]);
    this.context.set(null);
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
    this.radioResumePending = false;
    this.isPlaying.set(false);
  }

  resume(): void {
    this.radioResumePending = false;
    this.isPlaying.set(true);
  }

  addToQueue(track: Track): void {
    this.queue.update((q) => [...q, track]);
  }

  /** Insert a track to play immediately after the current one. */
  queueNext(track: Track): void {
    this.queue.update((q) => [track, ...q]);
  }

  /** Start radio seeded on a specific song: play it, then enable radio (which
   * replenishes from the current track). Clears any filter "vibe". */
  startRadio(track: Track): void {
    this.radioFilter.set(null);
    this.resetRadioRetry(); // a fresh user-started radio gets a fresh retry budget
    // A leftover queue would play out before radio ever kicked in.
    this.playSingle(track);
    if (!this.radio()) this.toggleRadio();
  }

  /** Start radio from a filter "vibe" (mood/genre/bpm): play the first track,
   * queue the rest, and remember the filter so auto-replenish stays in-vibe.
   * `tracks` are already filter-scored by the caller (LibraryApiService). */
  startRadioWithFilter(tracks: Track[], filter: LibraryFilter): void {
    if (tracks.length === 0) return;
    const [first, ...rest] = tracks;
    this.radioFilter.set(filter);
    this.resetRadioRetry(); // a fresh user-started vibe gets a fresh retry budget
    this.context.set(null);
    this.play(first);
    this.queue.set(rest);
    // Set directly (not toggleRadio, which resets the retry budget for a user
    // gesture). The trigger effect fires on this write; replenishRadio's
    // threshold guard makes it a no-op while the loaded queue is still deep.
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
      // With radio on this stop is exhaustion, not a user pause: an in-flight
      // replenish that lands late may auto-advance into the fresh tracks.
      if (this.radio()) this.radioResumePending = true;
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
    this.radioResumePending = false;
    this.resetRadioRetry();
    this.currentTrack.set(null);
    this.isPlaying.set(false);
    this.queue.set([]);
    this.history.set([]);
    this.context.set(null);
    this.currentTime.set(0);
    this.duration.set(0);
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
  // Bumped by the retry timer so the trigger effect re-runs replenishRadio.
  private readonly radioRetryNonce = signal(0);
  private radioRetryFailures = 0;
  private radioRetryTimer: ReturnType<typeof setTimeout> | null = null;
  // True only when playback stopped because the queue ran dry while radio was
  // on — the one case where a late replenish may auto-advance. Any user gesture
  // (play/pause/resume) or radio-off clears it, so a user pause is never
  // overridden.
  private radioResumePending = false;

  /** Register the source of "more tracks" for Radio (library access lives in a component). */
  setRadioProvider(provider: RadioProvider): void {
    this.radioProvider = provider;
  }

  toggleRadio(): void {
    this.radio.update((r) => !r);
    // The trigger effect sees the radio() write and handles the eager fill on
    // turn-on; both directions get a fresh retry budget.
    this.resetRadioRetry();
    if (!this.radio()) {
      this.radioFilter.set(null); // turning radio off ends the filter "vibe"
      this.radioResumePending = false;
    }
  }

  toggleVocalMute(): void {
    this.vocalsMuted.update((v) => !v);
  }

  /** Append fresh library tracks to the queue, skipping anything already lined
   * up. Self-guarding — every trigger (drain, radio toggle, retry) funnels here,
   * so the guard set can't fork per-caller again. Note there is deliberately no
   * repeat guard: repeat 'one' never drains the queue via playback, and radio
   * preempting repeat 'all''s context reload is the intended semantics. */
  private async replenishRadio(): Promise<void> {
    if (!this.radio() || !this.radioProvider || this.replenishing) return;
    if (this.currentTrack() === null) return;
    if (this.queue().length > RADIO_MIN_QUEUE) return;
    this.replenishing = true;
    let appended = false;
    try {
      const more = await this.radioProvider({
        currentTrack: this.currentTrack(),
        context: this.context(),
      });
      const seen = new Set<string>([
        this.currentTrack()?.id ?? '',
        ...this.queue().map((t) => t.id),
        ...this.history()
          .slice(-20)
          .map((t) => t.id),
      ]);
      const fresh = more.filter((t) => t.id && !seen.has(t.id));
      if (fresh.length) {
        this.queue.update((q) => [...q, ...fresh]);
        appended = true;
      }
    } catch {
      // Handled below as a retry — radio must not dead-end on one bad fetch.
    } finally {
      this.replenishing = false;
    }
    if (appended) {
      this.radioRetryFailures = 0;
      // The last track ended while the fetch was in flight: playback paused on
      // exhaustion, so advance into the fresh tracks (never after a user pause
      // — any gesture clears the flag).
      if (this.radioResumePending) {
        this.radioResumePending = false;
        this.playNext();
      }
    } else if (this.radio() && this.queue().length <= RADIO_MIN_QUEUE) {
      this.scheduleRadioRetry();
    }
  }

  /** Arm one bounded retry after a failed/empty replenish left the queue low. */
  private scheduleRadioRetry(): void {
    if (this.radioRetryTimer !== null) return;
    if (this.radioRetryFailures >= RADIO_MAX_RETRIES) return;
    this.radioRetryFailures++;
    this.radioRetryTimer = setTimeout(() => {
      this.radioRetryTimer = null;
      this.radioRetryNonce.update((n) => n + 1);
    }, RADIO_RETRY_MS);
  }

  private resetRadioRetry(): void {
    if (this.radioRetryTimer !== null) {
      clearTimeout(this.radioRetryTimer);
      this.radioRetryTimer = null;
    }
    this.radioRetryFailures = 0;
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
    this.queue.update((q) => {
      if (fromIndex < 0 || fromIndex >= q.length || toIndex < 0 || toIndex >= q.length) return q;
      const next = [...q];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
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
