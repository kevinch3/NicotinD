import { create } from 'zustand';
import * as db from '@/lib/preserve-store';
import { DEFAULT_BUDGET, type PreservedTrackMeta } from '@/lib/preserve-store';
import type { Track } from '@/stores/player';

interface PreserveState {
  preservedIds: Set<string>;
  totalUsage: number;
  budget: number;
  preserving: Set<string>;
  preservedTracks: PreservedTrackMeta[];

  init: () => Promise<void>;
  preserve: (track: Track, token: string | null) => Promise<void>;
  remove: (id: string) => Promise<void>;
  isPreserved: (id: string) => boolean;
  isPreserving: (id: string) => boolean;
  downloadToDevice: (id: string, filename: string) => Promise<void>;
  refreshList: () => Promise<void>;
}

export const usePreserveStore = create<PreserveState>((set, get) => ({
  preservedIds: new Set(),
  totalUsage: 0,
  budget: DEFAULT_BUDGET,
  preserving: new Set(),
  preservedTracks: [],

  init: async () => {
    const all = await db.getAll();
    const ids = new Set(all.map((t) => t.id));
    const usage = all.reduce((sum, t) => sum + t.size, 0);
    set({ preservedIds: ids, totalUsage: usage, preservedTracks: all });
  },

  preserve: async (track, token) => {
    const { preserving, budget } = get();
    if (!token || preserving.has(track.id) || get().preservedIds.has(track.id)) return;

    // Mark as preserving
    set({ preserving: new Set([...preserving, track.id]) });

    try {
      // Fetch audio first; cover fetch is best-effort so it doesn't block preserve.
      const audioRes = await fetch(`/api/stream/${track.id}?token=${token}`);
      if (!audioRes.ok) {
        throw new Error(`Failed to fetch audio: ${audioRes.status}`);
      }

      const audioBlob = await audioRes.blob();
      let coverBlob: Blob | null = null;

      if (track.coverArt) {
        try {
          const coverRes = await fetch(`/api/cover/${track.coverArt}?size=600&token=${token}`);
          if (coverRes.ok) {
            coverBlob = await coverRes.blob();
          }
        } catch {
          // Ignore cover failures so preserve still succeeds with audio only.
        }
      }

      // Evict if needed
      await db.evictLRU(audioBlob.size, budget);

      const now = Date.now();
      const meta: PreservedTrackMeta = {
        id: track.id,
        title: track.title,
        artist: track.artist,
        album: track.album ?? '',
        coverArt: track.coverArt,
        duration: track.duration,
        size: audioBlob.size,
        format: audioRes.headers.get('content-type') ?? 'audio/mpeg',
        preservedAt: now,
        lastAccessedAt: now,
      };

      await db.preserve(meta, audioBlob, coverBlob);

      // Update state
      const newIds = new Set(get().preservedIds);
      newIds.add(track.id);
      const newPreserving = new Set(get().preserving);
      newPreserving.delete(track.id);

      const all = await db.getAll();
      const usage = all.reduce((sum, t) => sum + t.size, 0);
      set({
        preservedIds: newIds,
        preserving: newPreserving,
        totalUsage: usage,
        preservedTracks: all,
      });
    } catch {
      // Remove from preserving on failure
      const newPreserving = new Set(get().preserving);
      newPreserving.delete(track.id);
      set({ preserving: newPreserving });
    }
  },

  remove: async (id) => {
    await db.remove(id);
    const newIds = new Set(get().preservedIds);
    newIds.delete(id);
    const all = await db.getAll();
    const usage = all.reduce((sum, t) => sum + t.size, 0);
    set({ preservedIds: newIds, totalUsage: usage, preservedTracks: all });
  },

  isPreserved: (id) => get().preservedIds.has(id),
  isPreserving: (id) => get().preserving.has(id),

  downloadToDevice: async (id, filename) => {
    const blob = await db.getBlob(id);
    if (!blob) return;

    const url = URL.createObjectURL(blob.audio);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  },

  refreshList: async () => {
    const all = await db.getAll();
    const ids = new Set(all.map((t) => t.id));
    const usage = all.reduce((sum, t) => sum + t.size, 0);
    set({ preservedIds: ids, totalUsage: usage, preservedTracks: all });
  },
}));
