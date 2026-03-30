import { create } from 'zustand';
import { api } from '@/lib/api';
import type { SlskdUserTransferGroup } from '@nicotind/core';
import type { TransferEntry } from '@/lib/transferTypes';
import { detectNewCompletion } from '@/lib/transferUtils';

// Re-export so consumers can import from one place
export type { TransferEntry } from '@/lib/transferTypes';

interface TransferStore {
  /** Flat lookup map: "username:filename" → TransferEntry */
  transfers: Map<string, TransferEntry>;
  /** Raw grouped data for Downloads.tsx (same shape as SlskdUserTransferGroup[]) */
  downloads: SlskdUserTransferGroup[];
  _intervalId: ReturnType<typeof setInterval> | null;
  poll: () => Promise<void>;
  startPolling: () => void;
  stopPolling: () => void;
  getStatus: (username: string, filename: string) => TransferEntry | undefined;
  libraryDirty: boolean;
  clearLibraryDirty: () => void;
}

export const useTransferStore = create<TransferStore>((set, get) => ({
  transfers: new Map(),
  downloads: [],
  _intervalId: null,
  libraryDirty: false,
  clearLibraryDirty: () => set({ libraryDirty: false }),

  poll: async () => {
    try {
      const data = await api.getDownloads();
      const map = new Map<string, TransferEntry>();
      for (const group of data) {
        for (const dir of group.directories) {
          for (const file of dir.files) {
            map.set(`${group.username}:${file.filename}`, {
              state: file.state,
              percent: file.percentComplete,
            });
          }
        }
      }
      const prevTransfers = get().transfers;
      const newCompletion = detectNewCompletion(prevTransfers, map);
      set({
        transfers: map,
        downloads: data,
        ...(newCompletion ? { libraryDirty: true } : {}),
      });
    } catch {
      // non-fatal: keep stale data on network error
    }
  },

  startPolling: () => {
    if (get()._intervalId) return; // guard: don't start twice
    get().poll();
    const id = setInterval(() => get().poll(), 3000);
    set({ _intervalId: id });
  },

  stopPolling: () => {
    const { _intervalId } = get();
    if (_intervalId) clearInterval(_intervalId);
    set({ _intervalId: null });
  },

  getStatus: (username, filename) =>
    get().transfers.get(`${username}:${filename}`),
}));
