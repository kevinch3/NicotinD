import { Injectable, signal, computed } from '@angular/core';

export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverArt?: string;
  duration?: number;
}

export interface PlayContext {
  type: 'album' | 'playlist' | 'adhoc';
  id?: string;
  name?: string;
  originalOrder: Track[];
}

function shuffleArray<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

@Injectable({ providedIn: 'root' })
export class PlayerService {
  readonly currentTrack = signal<Track | null>(null);
  readonly isPlaying = signal(false);
  readonly queue = signal<Track[]>([]);
  readonly history = signal<Track[]>([]);
  readonly shuffle = signal(false);
  readonly repeat = signal<'off' | 'all' | 'one'>('off');
  readonly context = signal<PlayContext | null>(null);
  readonly nowPlayingOpen = signal(false);
  readonly currentTime = signal(0);
  readonly duration = signal(0);
  readonly seekTo = signal<number | null>(null);
  readonly autoplayBlocked = signal(false);

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

    const newHistory = currentTrack
      ? [...this.history(), currentTrack]
      : this.history();
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
      const reloaded = shuffle
        ? shuffleArray(context.originalOrder)
        : [...context.originalOrder];
      const [first, ...rest] = reloaded;
      this.currentTrack.set(first);
      this.isPlaying.set(true);
      this.queue.set(rest);
      this.history.set([]);
    } else {
      this.currentTrack.set(null);
      this.isPlaying.set(false);
      this.history.set(newHistory);
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
  }

  toggleShuffle(): void {
    const shuffle = this.shuffle();
    const queue = this.queue();
    const currentTrack = this.currentTrack();
    const context = this.context();

    if (!shuffle) {
      // Turning ON: save original order, then shuffle queue
      const allTracks = currentTrack
        ? [currentTrack, ...queue]
        : [...queue];
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
        const restored =
          currentIdx >= 0 ? original.slice(currentIdx + 1) : [...original];
        this.shuffle.set(false);
        this.queue.set(restored);
      } else {
        this.shuffle.set(false);
      }
    }
  }

  cycleRepeat(): void {
    const current = this.repeat();
    const next =
      current === 'off' ? 'all' : current === 'all' ? 'one' : 'off';
    this.repeat.set(next);
  }

  playWithContext(
    tracks: Track[],
    startIndex: number,
    contextInfo?: {
      type: 'album' | 'playlist' | 'adhoc';
      id?: string;
      name?: string;
    },
  ): void {
    const shuffle = this.shuffle();
    const current = tracks[startIndex];
    const remaining = [
      ...tracks.slice(0, startIndex),
      ...tracks.slice(startIndex + 1),
    ];
    const queue = shuffle
      ? shuffleArray(remaining)
      : tracks.slice(startIndex + 1);

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
