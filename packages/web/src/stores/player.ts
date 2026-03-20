import { create } from 'zustand';

export interface Track {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverArt?: string;
  duration?: number;
}

interface PlayerState {
  currentTrack: Track | null;
  isPlaying: boolean;
  queue: Track[];
  play: (track: Track) => void;
  pause: () => void;
  resume: () => void;
  addToQueue: (track: Track) => void;
  playNext: () => void;
  clear: () => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  currentTrack: null,
  isPlaying: false,
  queue: [],
  play: (track) => set({ currentTrack: track, isPlaying: true }),
  pause: () => set({ isPlaying: false }),
  resume: () => set({ isPlaying: true }),
  addToQueue: (track) => set((s) => ({ queue: [...s.queue, track] })),
  playNext: () => {
    const { queue } = get();
    if (queue.length > 0) {
      const [next, ...rest] = queue;
      set({ currentTrack: next, isPlaying: true, queue: rest });
    } else {
      set({ currentTrack: null, isPlaying: false });
    }
  },
  clear: () => set({ currentTrack: null, isPlaying: false, queue: [] }),
}));
