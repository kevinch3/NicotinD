import { Injectable, signal, computed, effect, untracked } from '@angular/core';

export interface Track {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
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
  readonly context = signal<PlayContext | null>(null);
  readonly nowPlayingOpen = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly seekTo = signal<number | null>(null);
  readonly autoplayBlocked = signal(false);

  // Set by restoreState(); consumed by PlayerComponent.onDuration after audio is ready.
  restoredTime: number | null = null;

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

    // Radio: when the queue drains to RADIO_MIN_QUEUE (and we're not repeating),
    // pull more tracks from the library so playback continues. Reads queue()/radio()
    // so it re-runs on any drain (next track, manual removal); the actual fetch +
    // queue append happens async (untracked) so it never loops on its own write.
    effect(() => {
      const queueLen = this.queue().length;
      const radioOn = this.radio();
      if (!radioOn || queueLen > RADIO_MIN_QUEUE) return;
      const hasCurrent = untracked(() => this.currentTrack()) !== null;
      const repeating = untracked(() => this.repeat()) !== 'off';
      if (hasCurrent && !repeating) untracked(() => void this.replenishRadio());
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
      // Attempt to resume if the user was playing — browser autoplay policy applies;
      // Effect 1 will call audio.play() and show the "Tap to resume" banner on rejection.
      if (state['wasPlaying']) this.isPlaying.set(true);
      if (Array.isArray(state['queue'])) this.queue.set(state['queue'] as Track[]);
      if (Array.isArray(state['history'])) this.history.set(state['history'] as Track[]);
      if (state['shuffle'] != null) this.shuffle.set(Boolean(state['shuffle']));
      if (state['repeat'] != null) this.repeat.set(state['repeat'] as 'off' | 'all' | 'one');
      if (state['radio'] != null) this.radio.set(Boolean(state['radio']));
      if (isPlayContext(state['context'])) this.context.set(state['context']);
      if (typeof state['currentTime'] === 'number' && state['currentTime'] > 1) {
        this.restoredTime = state['currentTime'];
      }
    } catch {
      localStorage.removeItem(PlayerService.STORAGE_KEY);
    }
  }

  play(track: Track): void {
    this.currentTrack.set(track);
    this.isPlaying.set(true);
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

  /** Register the source of "more tracks" for Radio (library access lives in a component). */
  setRadioProvider(provider: RadioProvider): void {
    this.radioProvider = provider;
  }

  toggleRadio(): void {
    this.radio.update((r) => !r);
    // Turning it on with a low queue should fill immediately, not wait for a drain.
    if (this.radio()) untracked(() => void this.replenishRadio());
  }

  /** Append fresh library tracks to the queue, skipping anything already lined up. */
  private async replenishRadio(): Promise<void> {
    if (!this.radioProvider || this.replenishing) return;
    if (this.queue().length > RADIO_MIN_QUEUE) return;
    this.replenishing = true;
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
      if (fresh.length) this.queue.update((q) => [...q, ...fresh]);
    } catch {
      // Non-fatal — radio simply doesn't extend this time.
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

  setAutoplayBlocked(blocked: boolean): void {
    this.autoplayBlocked.set(blocked);
  }
}
