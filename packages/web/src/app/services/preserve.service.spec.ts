import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { PreserveService, PRESERVE_STORE, UNLIMITED_BUDGET } from './preserve.service';
import type { PreserveStore } from './preserve.service';
import { AuthService } from './auth.service';
import type { Track } from './player.service';

// In-memory fake of the IndexedDB store, injected via PRESERVE_STORE. The
// Angular unit-test system forbids `vi.mock` on relative imports, so the store
// is swapped through DI instead of module mocking.
type StoredMeta = { id: string; size: number; lastAccessedAt: number; source: 'user' | 'auto' };

function makeStoreFake() {
  const tracks = new Map<string, StoredMeta>();
  return {
    preserve: vi.fn(async (meta: StoredMeta) => {
      tracks.set(meta.id, meta);
    }),
    remove: vi.fn(async (id: string) => {
      tracks.delete(id);
    }),
    getAll: vi.fn(async () => [...tracks.values()]),
    getBlob: vi.fn(async () => undefined),
    evictLRU: vi.fn(async () => [] as string[]),
    evictAutoLRU: vi.fn(async () => [] as string[]),
    removeAllAutoPreserved: vi.fn(async () => {
      let n = 0;
      for (const [id, t] of tracks) {
        if (t.source === 'auto') {
          tracks.delete(id);
          n++;
        }
      }
      return n;
    }),
    clearAll: vi.fn(async () => {
      tracks.clear();
    }),
    reset: () => tracks.clear(),
  } as unknown as PreserveStore & { reset: () => void };
}

let store: PreserveStore & { reset: () => void };

const BLOB_SIZE = 100;

function track(id: string): Track {
  return { id, title: `Title ${id}`, artist: 'Artist' };
}

function mockFetch() {
  // Audio response only (tracks carry no coverArt → no second fetch).
  return vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob([new Uint8Array(BLOB_SIZE)]),
    headers: { get: () => 'audio/mpeg' },
  })) as unknown as typeof fetch;
}

describe('PreserveService', () => {
  let svc: PreserveService;

  beforeEach(() => {
    store = makeStoreFake();
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.fetch = mockFetch();

    TestBed.configureTestingModule({
      providers: [
        PreserveService,
        { provide: AuthService, useValue: { token: signal('tok') } },
        { provide: PRESERVE_STORE, useValue: store },
      ],
    });
    svc = TestBed.inject(PreserveService);
  });

  describe('preserveCollection', () => {
    it('stores every track when under budget', async () => {
      await svc.preserveCollection('album1', 'Album', [track('a'), track('b'), track('c')]);

      expect(svc.preservedIds().size).toBe(3);
      expect(svc.isCollectionPreserved(['a', 'b', 'c'])).toBe(true);
      // Fully completed → no lingering batch for that key.
      expect(svc.batchFor('album1')).toBeNull();
    });

    it('stops at the cap and keeps what fit (no eviction of the same batch)', async () => {
      // Budget fits exactly two 100-byte tracks (third would overflow).
      svc.setBudget(250);

      await svc.preserveCollection('big', 'Big', [track('a'), track('b'), track('c'), track('d')]);

      expect(svc.preservedIds().size).toBe(2);
      expect(svc.totalUsage()).toBe(2 * BLOB_SIZE);
      // evictLRU is the single-track path only — bulk must never call it.
      expect(store.evictLRU).not.toHaveBeenCalled();

      const batch = svc.batchFor('big');
      expect(batch?.stoppedAtCap).toBe(true);
      expect(batch?.done).toBe(2);
      expect(batch?.total).toBe(4);
    });

    it('skips already-preserved tracks', async () => {
      await svc.preserve(track('a'));
      expect(svc.preservedIds().has('a')).toBe(true);

      await svc.preserveCollection('mix', 'Mix', [track('a'), track('b')]);

      // Only the new track counts toward the batch total.
      expect(svc.preservedIds().size).toBe(2);
    });

    it('runs different collections in parallel with scoped progress', async () => {
      const a = svc.preserveCollection('a', 'A', [track('a1'), track('a2')]);
      const b = svc.preserveCollection('b', 'B', [track('b1')]);

      // Both batches active and scoped to their own key — neither blocks the other,
      // and an unrelated page sees no batch (template-scoping regression).
      expect(svc.batchFor('a')?.name).toBe('A');
      expect(svc.batchFor('b')?.name).toBe('B');
      expect(svc.batchFor('unrelated')).toBeNull();

      await Promise.all([a, b]);

      expect(svc.preservedIds().has('a1')).toBe(true);
      expect(svc.preservedIds().has('a2')).toBe(true);
      expect(svc.preservedIds().has('b1')).toBe(true);
    });

    it('ignores a re-entrant call for an already-active collection', async () => {
      const first = svc.preserveCollection('same', 'Same', [track('a'), track('b')]);
      // Same key while active → no-op (does not start a second pass).
      await svc.preserveCollection('same', 'Same', [track('c')]);
      await first;

      expect(svc.preservedIds().has('c')).toBe(false);
    });

    it('parallel batches share the live budget and do not collectively overshoot', async () => {
      svc.setBudget(250); // fits exactly two 100-byte tracks across both batches

      const a = svc.preserveCollection('a', 'A', [track('a1'), track('a2')]);
      const b = svc.preserveCollection('b', 'B', [track('b1'), track('b2')]);
      await Promise.all([a, b]);

      expect(svc.preservedIds().size).toBe(2);
      expect(svc.totalUsage()).toBe(2 * BLOB_SIZE);
    });

    it('dismissBatch clears the lingering cap notice for its key', async () => {
      svc.setBudget(150);
      await svc.preserveCollection('big', 'Big', [track('a'), track('b')]);
      expect(svc.batchFor('big')?.stoppedAtCap).toBe(true);
      svc.dismissBatch('big');
      expect(svc.batchFor('big')).toBeNull();
    });
  });

  describe('budget persistence', () => {
    it('setBudget writes through to localStorage', () => {
      svc.setBudget(5 * 1024 * 1024 * 1024);
      expect(localStorage.getItem('nicotind-preserve-budget')).toBe(String(5 * 1024 * 1024 * 1024));
      expect(svc.budget()).toBe(5 * 1024 * 1024 * 1024);
    });

    it('rehydrates the budget from localStorage on construction', () => {
      localStorage.setItem('nicotind-preserve-budget', String(UNLIMITED_BUDGET));
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          PreserveService,
          { provide: AuthService, useValue: { token: signal('tok') } },
          { provide: PRESERVE_STORE, useValue: store },
        ],
      });
      const fresh = TestBed.inject(PreserveService);
      expect(fresh.budget()).toBe(UNLIMITED_BUDGET);
    });
  });

  describe('isCollectionPreserved', () => {
    it('returns false for an empty id list', () => {
      expect(svc.isCollectionPreserved([])).toBe(false);
    });
  });

  describe('clearAll', () => {
    it('clears all preserved tracks and resets signals', async () => {
      await svc.preserveCollection('album1', 'Album', [track('a'), track('b'), track('c')]);
      expect(svc.preservedIds().size).toBe(3);
      expect(svc.totalUsage()).toBe(3 * BLOB_SIZE);

      await svc.clearAll();

      expect(svc.preservedIds().size).toBe(0);
      expect(svc.totalUsage()).toBe(0);
      expect(svc.preservedTracks()).toEqual([]);
      expect(svc.preserving().size).toBe(0);
      expect(svc.batches().size).toBe(0);
      expect(store.clearAll).toHaveBeenCalled();
    });
  });

  describe('autoPreserve', () => {
    it('tags the row with source="auto" (not "user")', async () => {
      await svc.autoPreserve(track('a'));

      expect(store.preserve).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a', source: 'auto' }),
        expect.anything(),
        null,
      );
      expect(svc.autoPreservedCount()).toBe(1);
    });

    it('routes eviction through evictAutoLRU (not evictLRU)', async () => {
      await svc.autoPreserve(track('a'));

      expect(store.evictAutoLRU).toHaveBeenCalledWith(BLOB_SIZE, svc.budget());
      expect(store.evictLRU).not.toHaveBeenCalled();
    });

    it('user preserve routes through evictLRU (not evictAutoLRU)', async () => {
      await svc.preserve(track('a'));

      expect(store.evictLRU).toHaveBeenCalledWith(BLOB_SIZE, svc.budget());
      expect(store.evictAutoLRU).not.toHaveBeenCalled();
      expect(svc.autoPreservedCount()).toBe(0);
    });

    it('is idempotent — already-preserved tracks are no-op', async () => {
      await svc.autoPreserve(track('a'));
      const callsAfterFirst = vi.mocked(store.preserve).mock.calls.length;

      await svc.autoPreserve(track('a'));

      expect(vi.mocked(store.preserve).mock.calls.length).toBe(callsAfterFirst);
    });
  });

  describe('ensureAutoPreservedFor', () => {
    it('skips already-preserved and in-flight tracks', async () => {
      svc.setAutoPreserveMode('full');
      await svc.autoPreserve(track('a'));
      svc.preserving.update((s) => new Set(s).add('b'));

      await svc.ensureAutoPreservedFor([track('a'), track('b'), track('c')]);

      // Only `c` triggers a fetch; `a` is preserved and `b` is in flight.
      expect(store.preserve).toHaveBeenCalledTimes(2); // 'a' (auto) + 'c' (auto)
      expect(svc.preservedIds().has('a')).toBe(true);
      expect(svc.preservedIds().has('c')).toBe(true);
    });

    it('no-ops when autoPreserveMode is "off"', async () => {
      svc.setAutoPreserveMode('off');
      await svc.ensureAutoPreservedFor([track('a'), track('b')]);
      expect(store.preserve).not.toHaveBeenCalled();
    });
  });

  describe('removeAllAutoPreserved', () => {
    it('removes only auto-source rows, leaves user-source rows intact', async () => {
      // Seed mixed-source rows directly via the store fake.
      store.preserve({ id: 'u1', size: 100, lastAccessedAt: 0, source: 'user' } as never);
      store.preserve({ id: 'a1', size: 100, lastAccessedAt: 0, source: 'auto' } as never);
      store.preserve({ id: 'a2', size: 100, lastAccessedAt: 0, source: 'auto' } as never);
      await svc.refreshList();

      const removed = await svc.removeAllAutoPreserved();

      expect(removed).toBe(2);
      expect(svc.preservedIds().has('u1')).toBe(true);
      expect(svc.preservedIds().has('a1')).toBe(false);
      expect(svc.preservedIds().has('a2')).toBe(false);
      expect(svc.autoPreservedCount()).toBe(0);
    });
  });

  describe('windowSize', () => {
    beforeEach(() => svc.setAutoPreserveMode('off'));

    it('returns 0 when mode is off (regardless of length)', () => {
      svc.setAutoPreserveMode('off');
      expect(svc.windowSize(0)).toBe(0);
      expect(svc.windowSize(100)).toBe(0);
    });

    it('caps at 5 when mode is "5"', () => {
      svc.setAutoPreserveMode('5');
      expect(svc.windowSize(3)).toBe(3);
      expect(svc.windowSize(20)).toBe(5);
    });

    it('caps at 20 when mode is "20"', () => {
      svc.setAutoPreserveMode('20');
      expect(svc.windowSize(3)).toBe(3);
      expect(svc.windowSize(20)).toBe(20);
      expect(svc.windowSize(100)).toBe(20);
    });

    it('caps at 200 when mode is "full" (hard cap for radio safety)', () => {
      svc.setAutoPreserveMode('full');
      expect(svc.windowSize(3)).toBe(3);
      expect(svc.windowSize(500)).toBe(200);
    });

    it('returns 0 for empty queue', () => {
      svc.setAutoPreserveMode('full');
      expect(svc.windowSize(0)).toBe(0);
    });
  });

  describe('autoPreserveMode persistence', () => {
    it('setAutoPreserveMode writes through to localStorage', () => {
      svc.setAutoPreserveMode('5');
      expect(localStorage.getItem('nicotind-auto-preserve')).toBe('5');
      expect(svc.autoPreserveMode()).toBe('5');
    });

    it('rehydrates from localStorage on construction', () => {
      localStorage.setItem('nicotind-auto-preserve', '20');
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          PreserveService,
          { provide: AuthService, useValue: { token: signal('tok') } },
          { provide: PRESERVE_STORE, useValue: store },
        ],
      });
      const fresh = TestBed.inject(PreserveService);
      expect(fresh.autoPreserveMode()).toBe('20');
    });

    it('falls back to "off" on corrupt localStorage', () => {
      localStorage.setItem('nicotind-auto-preserve', 'not-a-mode');
      TestBed.resetTestingModule();
      TestBed.configureTestingModule({
        providers: [
          PreserveService,
          { provide: AuthService, useValue: { token: signal('tok') } },
          { provide: PRESERVE_STORE, useValue: store },
        ],
      });
      const fresh = TestBed.inject(PreserveService);
      expect(fresh.autoPreserveMode()).toBe('off');
    });
  });
});
