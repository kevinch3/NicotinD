import { create } from 'zustand';

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

interface PlayerState {
  currentTrack: Track | null;
  isPlaying: boolean;
  queue: Track[];
  history: Track[];
  shuffle: boolean;
  repeat: 'off' | 'all' | 'one';
  context: PlayContext | null;
  nowPlayingOpen: boolean;
  currentTime: number;
  duration: number;

  play: (track: Track) => void;
  pause: () => void;
  resume: () => void;
  addToQueue: (track: Track) => void;
  playNext: () => void;
  playPrev: () => void;
  clear: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  playWithContext: (
    tracks: Track[],
    startIndex: number,
    contextInfo?: { type: 'album' | 'playlist' | 'adhoc'; id?: string; name?: string },
  ) => void;
  removeFromQueue: (index: number) => void;
  setNowPlayingOpen: (open: boolean) => void;
  setCurrentTime: (time: number) => void;
  setDuration: (duration: number) => void;
  setCurrentTrackMetadata: (track: Track) => void;
  seekTo: number | null;
  seek: (time: number) => void;
  clearSeek: () => void;
  autoplayBlocked: boolean;
  setAutoplayBlocked: (blocked: boolean) => void;
}

function shuffleArray<T>(arr: T[]): T[] {
  // TODO: Implement Fisher-Yates shuffle
  // Iterate from the last element to the second, swapping each with a random earlier element
  // This guarantees uniform distribution in O(n) time
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  isPlaying: false,
  queue: [],
  history: [],
  shuffle: false,
  repeat: 'off',
  context: null,
  nowPlayingOpen: false,
  currentTime: 0,
  duration: 0,
  seekTo: null,

  play: (track) => set({ currentTrack: track, isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  resume: () => set({ isPlaying: true }),

  addToQueue: (track) => set((s) => ({ queue: [...s.queue, track] })),

  playNext: () => {
    const { queue, currentTrack, repeat, context, shuffle } = get();

    // repeat one: signal replay (Player component handles audio.currentTime = 0)
    if (repeat === 'one') {
      // Re-set the same track to trigger the useEffect in Player
      set({ currentTrack: currentTrack ? { ...currentTrack } : null, isPlaying: true });
      return;
    }

    const newHistory = currentTrack ? [...get().history, currentTrack] : get().history;

    if (queue.length > 0) {
      const [next, ...rest] = queue;
      set({ currentTrack: next, isPlaying: true, queue: rest, history: newHistory });
    } else if (repeat === 'all' && context) {
      // Reload from context
      const reloaded = shuffle
        ? shuffleArray(context.originalOrder)
        : [...context.originalOrder];
      const [first, ...rest] = reloaded;
      set({ currentTrack: first, isPlaying: true, queue: rest, history: [] });
    } else {
      set({ currentTrack: null, isPlaying: false, history: newHistory });
    }
  },

  playPrev: () => {
    const { history, currentTrack, queue } = get();
    if (history.length > 0) {
      const newHistory = [...history];
      const prev = newHistory.pop()!;
      const newQueue = currentTrack ? [currentTrack, ...queue] : queue;
      set({ currentTrack: prev, isPlaying: true, history: newHistory, queue: newQueue });
    }
    // If no history, no-op — Player component handles the >3s restart
  },

  clear: () =>
    set({
      currentTrack: null,
      isPlaying: false,
      queue: [],
      history: [],
      context: null,
      currentTime: 0,
      duration: 0,
    }),

  toggleShuffle: () => {
    const { shuffle, queue, currentTrack, context } = get();

    if (!shuffle) {
      // Turning ON: save original order, then shuffle queue
      const allTracks = currentTrack ? [currentTrack, ...queue] : [...queue];
      const ctx = context ?? { type: 'adhoc' as const, originalOrder: allTracks };
      if (!context) {
        // Auto-create adhoc context
        set({ context: { ...ctx, originalOrder: allTracks } });
      } else {
        // Update original order to include current state
        set({ context: { ...context, originalOrder: allTracks } });
      }
      set({ shuffle: true, queue: shuffleArray(queue) });
    } else {
      // Turning OFF: restore original order relative to current track
      if (context) {
        const currentId = currentTrack?.id;
        const original = context.originalOrder;
        const currentIdx = original.findIndex((t) => t.id === currentId);
        const restored = currentIdx >= 0 ? original.slice(currentIdx + 1) : [...original];
        set({ shuffle: false, queue: restored });
      } else {
        set({ shuffle: false });
      }
    }
  },

  cycleRepeat: () => {
    const { repeat } = get();
    const next = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
    set({ repeat: next });
  },

  playWithContext: (tracks, startIndex, contextInfo) => {
    const { shuffle } = get();
    const current = tracks[startIndex];
    const remaining = [...tracks.slice(0, startIndex), ...tracks.slice(startIndex + 1)];
    const queue = shuffle ? shuffleArray(remaining) : tracks.slice(startIndex + 1);

    set({
      currentTrack: current,
      isPlaying: true,
      queue,
      history: [],
      context: {
        type: contextInfo?.type ?? 'adhoc',
        id: contextInfo?.id,
        name: contextInfo?.name,
        originalOrder: tracks,
      },
    });
  },

  removeFromQueue: (index) =>
    set((s) => ({ queue: s.queue.filter((_, i) => i !== index) })),

  setNowPlayingOpen: (open) => set({ nowPlayingOpen: open }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setDuration: (d) => set({ duration: d }),
  seek: (time) => set({ seekTo: time }),
  clearSeek: () => set({ seekTo: null }),
  setCurrentTrackMetadata: (track) => set({ currentTrack: track }),
  autoplayBlocked: false,
  setAutoplayBlocked: (blocked) => set({ autoplayBlocked: blocked }),
}));
