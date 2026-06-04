import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { PreserveService, UNLIMITED_BUDGET } from './preserve.service';
import { AuthService } from './auth.service';
import type { Track } from './player.service';

// In-memory fake of the IndexedDB store module. vi.mock is hoisted and
// file-scoped, so this does not leak into other specs.
vi.mock('../lib/preserve-store', () => {
  const tracks = new Map<string, { id: string; size: number; lastAccessedAt: number }>();
  return {
    DEFAULT_BUDGET: 2 * 1024 * 1024 * 1024,
    preserve: vi.fn(async (meta: { id: string; size: number; lastAccessedAt: number }) => {
      tracks.set(meta.id, meta);
    }),
    remove: vi.fn(async (id: string) => {
      tracks.delete(id);
    }),
    getAll: vi.fn(async () => [...tracks.values()]),
    getBlob: vi.fn(async () => undefined),
    evictLRU: vi.fn(async () => [] as string[]),
    updateLastAccessed: vi.fn(async () => {}),
    __reset: () => tracks.clear(),
  };
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
import * as store from '../lib/preserve-store';

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
    (store as unknown as { __reset: () => void }).__reset();
    vi.clearAllMocks();
    localStorage.clear();
    globalThis.fetch = mockFetch();

    TestBed.configureTestingModule({
      providers: [PreserveService, { provide: AuthService, useValue: { token: signal('tok') } }],
    });
    svc = TestBed.inject(PreserveService);
  });

  describe('preserveCollection', () => {
    it('stores every track when under budget', async () => {
      await svc.preserveCollection('Album', [track('a'), track('b'), track('c')]);

      expect(svc.preservedIds().size).toBe(3);
      expect(svc.isCollectionPreserved(['a', 'b', 'c'])).toBe(true);
      // Fully completed → no lingering batch.
      expect(svc.batch()).toBeNull();
    });

    it('stops at the cap and keeps what fit (no eviction of the same batch)', async () => {
      // Budget fits exactly two 100-byte tracks (third would overflow).
      svc.setBudget(250);

      await svc.preserveCollection('Big', [track('a'), track('b'), track('c'), track('d')]);

      expect(svc.preservedIds().size).toBe(2);
      expect(svc.totalUsage()).toBe(2 * BLOB_SIZE);
      // evictLRU is the single-track path only — bulk must never call it.
      expect(store.evictLRU).not.toHaveBeenCalled();

      const batch = svc.batch();
      expect(batch?.stoppedAtCap).toBe(true);
      expect(batch?.done).toBe(2);
      expect(batch?.total).toBe(4);
    });

    it('skips already-preserved tracks', async () => {
      await svc.preserve(track('a'));
      expect(svc.preservedIds().has('a')).toBe(true);

      await svc.preserveCollection('Mix', [track('a'), track('b')]);

      // Only the new track counts toward the batch total.
      expect(svc.preservedIds().size).toBe(2);
    });

    it('ignores a concurrent collection while one is running', async () => {
      const first = svc.preserveCollection('One', [track('a'), track('b')]);
      // Second call returns immediately because a batch is active.
      await svc.preserveCollection('Two', [track('c')]);
      await first;

      expect(svc.preservedIds().has('c')).toBe(false);
    });

    it('dismissBatch clears the lingering cap notice', async () => {
      svc.setBudget(150);
      await svc.preserveCollection('Big', [track('a'), track('b')]);
      expect(svc.batch()?.stoppedAtCap).toBe(true);
      svc.dismissBatch();
      expect(svc.batch()).toBeNull();
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
        providers: [PreserveService, { provide: AuthService, useValue: { token: signal('tok') } }],
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
});
