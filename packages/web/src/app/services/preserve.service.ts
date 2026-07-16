import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import * as db from '../lib/preserve-store';
import {
  DEFAULT_BUDGET,
  type PreservedTrackMeta,
  type PreserveSource,
} from '../lib/preserve-store';
import type { Track } from './player.service';
import { AuthService } from './auth.service';
import { ServerConfigService } from './server-config.service';

/**
 * The IndexedDB-backed store, injected so tests can swap in an in-memory fake.
 * The Angular unit-test system forbids `vi.mock` on relative imports, so the
 * store is provided through DI rather than module mocking.
 */
export interface PreserveStore {
  preserve: typeof db.preserve;
  remove: typeof db.remove;
  getBlob: typeof db.getBlob;
  getAll: typeof db.getAll;
  evictLRU: typeof db.evictLRU;
  evictAutoLRU: typeof db.evictAutoLRU;
  removeAllAutoPreserved: typeof db.removeAllAutoPreserved;
  clearAll: typeof db.clearAll;
}

export const PRESERVE_STORE = new InjectionToken<PreserveStore>('PRESERVE_STORE', {
  providedIn: 'root',
  factory: () => db,
});

/** Sentinel "no cap" budget — large enough that the projected-usage check never trips. */
export const UNLIMITED_BUDGET = Number.MAX_SAFE_INTEGER;

const BUDGET_STORAGE_KEY = 'nicotind-preserve-budget';
const AUTO_PRESERVE_STORAGE_KEY = 'nicotind-auto-preserve';

/** Auto-preserve window — how far ahead of the playhead to keep on disk. */
export type AutoPreserveMode = 'off' | '5' | '20' | 'full';

/** Hard cap on the "full" window so a runaway radio can't fill 50 GB. */
const AUTO_PRESERVE_FULL_CAP = 200;
/** Concurrency limit for auto-preserve fetches — bounds memory + parallel network. */
const AUTO_PRESERVE_CONCURRENCY = 3;

/** Live progress for an in-flight collection ("Download album/playlist/genre") preserve. */
export interface PreserveBatch {
  /** Collection name (album/playlist/genre) — used to scope UI notices to the originating page. */
  name: string;
  done: number;
  total: number;
  /** True when the batch stopped because the storage budget filled up. */
  stoppedAtCap: boolean;
}

const VALID_AUTO_MODES = new Set<AutoPreserveMode>(['off', '5', '20', 'full']);

@Injectable({ providedIn: 'root' })
export class PreserveService {
  private auth = inject(AuthService);
  private server = inject(ServerConfigService);
  private db = inject(PRESERVE_STORE);

  readonly preservedIds = signal(new Set<string>());
  readonly totalUsage = signal(0);
  readonly budget = signal(loadBudget());
  readonly preserving = signal(new Set<string>());
  readonly preservedTracks = signal<PreservedTrackMeta[]>([]);
  /**
   * In-flight collection downloads, keyed by a stable collection id (album/
   * playlist id, genre slug). A map — not a single batch — so different
   * collections download in parallel and each page shows only its own progress.
   */
  readonly batches = signal<Map<string, PreserveBatch>>(new Map());

  /**
   * Auto-preserve window. Per-device localStorage so the user can enable it
   * on a phone without affecting a shared desktop. Default 'off' — the
   * lock-screen resilience is opt-in so we don't surprise anyone with
   * background network usage.
   */
  readonly autoPreserveMode = signal<AutoPreserveMode>(loadAutoPreserveMode());

  async init(): Promise<void> {
    await this.refreshList();
  }

  /** Persist the offline storage budget (bytes). Use UNLIMITED_BUDGET for "no cap". */
  setBudget(bytes: number): void {
    this.budget.set(bytes);
    try {
      localStorage.setItem(BUDGET_STORAGE_KEY, String(bytes));
    } catch {
      /* ignore quota / private-mode failures */
    }
  }

  /** Persist the auto-preserve window (per-device localStorage). */
  setAutoPreserveMode(mode: AutoPreserveMode): void {
    this.autoPreserveMode.set(mode);
    try {
      localStorage.setItem(AUTO_PRESERVE_STORAGE_KEY, mode);
    } catch {
      /* ignore */
    }
  }

  /**
   * Pure helper — how many tracks to keep given current mode + window length.
   * 'off' disables auto-preserve. '5'/'20' cap at the window size or queue
   * length, whichever is smaller. 'full' is bounded by AUTO_PRESERVE_FULL_CAP
   * so a runaway radio never fills tens of GB.
   */
  windowSize(trackCount: number): number {
    if (trackCount <= 0) return 0;
    switch (this.autoPreserveMode()) {
      case 'off':
        return 0;
      case '5':
        return Math.min(5, trackCount);
      case '20':
        return Math.min(20, trackCount);
      case 'full':
        return Math.min(AUTO_PRESERVE_FULL_CAP, trackCount);
    }
  }

  /** Count of preserved tracks tagged `source === 'auto'`. */
  autoPreservedCount(): number {
    let n = 0;
    for (const t of this.preservedTracks()) if (t.source === 'auto') n++;
    return n;
  }

  async preserve(track: Track): Promise<void> {
    await this.preserveWithSource(track, 'user');
  }

  /**
   * Auto-preserve variant — same fetch + store path but tags the row as
   * `source: 'auto'` so the eviction policy treats it as cheap-to-lose.
   * Idempotent: re-entry and already-preserved guards mirror `preserve()`.
   */
  async autoPreserve(track: Track): Promise<void> {
    await this.preserveWithSource(track, 'auto');
  }

  private async preserveWithSource(track: Track, source: PreserveSource): Promise<void> {
    const token = this.auth.token();
    if (!token || this.preserving().has(track.id) || this.preservedIds().has(track.id)) return;

    this.preserving.update((s) => new Set(s).add(track.id));
    try {
      const blobs = await this.fetchTrackBlobs(track, token);
      if (!blobs) return;
      // Single-track save evicts least-recently-played tracks to make room (LRU).
      // Auto paths route through evictAutoLRU first (never touches user rows);
      // user paths route through evictLRU (auto-first, user fallback).
      if (source === 'auto') {
        await this.db.evictAutoLRU(blobs.audioBlob.size, this.budget());
      } else {
        await this.db.evictLRU(blobs.audioBlob.size, this.budget());
      }
      await this.storeTrack(track, blobs, source);
      await this.refreshList();
    } catch {
      /* swallow — failure leaves the track un-preserved */
    } finally {
      this.clearPreserving(track.id);
    }
  }

  /**
   * Idempotent batch entry point for the auto-preserve coordinator. Walks
   * `tracks`, skipping any already-preserved or in-flight. Caps concurrency
   * at AUTO_PRESERVE_CONCURRENCY so a long radio queue can't spike memory or
   * saturate the network on a slow device.
   */
  async ensureAutoPreservedFor(tracks: Track[]): Promise<void> {
    if (this.autoPreserveMode() === 'off') return;
    const token = this.auth.token();
    if (!token) return;

    const todo = tracks.filter(
      (t) => t && !this.preservedIds().has(t.id) && !this.preserving().has(t.id),
    );
    if (todo.length === 0) return;

    // Bounded-concurrency queue — process AUTO_PRESERVE_CONCURRENCY at a time.
    let cursor = 0;
    const workers = Array.from(
      { length: Math.min(AUTO_PRESERVE_CONCURRENCY, todo.length) },
      async () => {
        while (cursor < todo.length) {
          const idx = cursor++;
          await this.autoPreserve(todo[idx]);
        }
      },
    );
    await Promise.all(workers);
  }

  /**
   * Preserve a whole collection (album / playlist / genre) for offline use.
   *
   * Cap behavior: downloads until the configured budget is full, then stops —
   * it does NOT evict tracks from the same batch (unlike single-track `preserve`),
   * so the user keeps whatever fit instead of thrashing freshly-saved tracks.
   */
  async preserveCollection(key: string, name: string, tracks: Track[]): Promise<void> {
    const token = this.auth.token();
    // Only block re-entry for the *same* collection — different keys run in parallel.
    if (!token || this.batches().has(key)) return;

    const pending = tracks.filter((t) => !this.preservedIds().has(t.id));
    if (pending.length === 0) return;

    this.setBatch(key, { name, done: 0, total: pending.length, stoppedAtCap: false });
    const budget = this.budget();

    try {
      for (const track of pending) {
        if (this.preservedIds().has(track.id)) {
          this.bumpBatch(key);
          continue;
        }
        this.preserving.update((s) => new Set(s).add(track.id));
        try {
          const blobs = await this.fetchTrackBlobs(track, token);
          if (!blobs) continue;
          // Budget check reads the live `totalUsage` signal (not a per-call local)
          // so concurrent collection batches share the same running total and
          // can't collectively overshoot the cap.
          if (this.totalUsage() + blobs.audioBlob.size > budget) {
            this.updateBatch(key, (b) => ({ ...b, stoppedAtCap: true }));
            break;
          }
          await this.storeTrack(track, blobs, 'user');
          this.totalUsage.update((u) => u + blobs.audioBlob.size);
          this.bumpBatch(key);
        } finally {
          this.clearPreserving(track.id);
        }
      }
    } finally {
      await this.refreshList();
      // Keep the final state visible when we hit the cap (drives the "limit reached"
      // notice); otherwise clear so the button returns to its resting state.
      if (!this.batches().get(key)?.stoppedAtCap) this.clearBatch(key);
    }
  }

  /** Dismiss the lingering "storage limit reached" batch notice for a collection. */
  dismissBatch(key: string | null | undefined): void {
    if (key) this.clearBatch(key);
  }

  /** Live progress for a collection download, or null when it isn't downloading. */
  batchFor(key: string | null | undefined): PreserveBatch | null {
    return key ? (this.batches().get(key) ?? null) : null;
  }

  async remove(id: string): Promise<void> {
    await this.db.remove(id);
    this.preservedIds.update((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    await this.refreshList();
  }

  async removeMany(ids: string[]): Promise<void> {
    for (const id of ids) await this.db.remove(id);
    this.preservedIds.update((s) => {
      const n = new Set(s);
      for (const id of ids) n.delete(id);
      return n;
    });
    await this.refreshList();
  }

  /**
   * Remove every preserved track tagged `source === 'auto'`. User-saved
   * tracks are untouched. Used by the Settings "Auto-preserve queue" toggle
   * when the user turns the feature off.
   */
  async removeAllAutoPreserved(): Promise<number> {
    const count = await this.db.removeAllAutoPreserved();
    await this.refreshList();
    return count;
  }

  async clearAll(): Promise<void> {
    await this.db.clearAll();
    this.preservedIds.set(new Set());
    this.totalUsage.set(0);
    this.preserving.set(new Set());
    this.preservedTracks.set([]);
    this.batches.set(new Map());
  }

  isPreserved(id: string): boolean {
    return this.preservedIds().has(id);
  }

  isPreserving(id: string): boolean {
    return this.preserving().has(id);
  }

  /** True when every track in the collection is already preserved offline. */
  isCollectionPreserved(ids: string[]): boolean {
    if (ids.length === 0) return false;
    const set = this.preservedIds();
    return ids.every((id) => set.has(id));
  }

  async downloadToDevice(id: string, filename: string): Promise<void> {
    const blob = await this.db.getBlob(id);
    if (!blob) return;

    const url = URL.createObjectURL(blob.audio);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  async refreshList(): Promise<void> {
    const all = await this.db.getAll();
    const ids = new Set(all.map((t) => t.id));
    const usage = all.reduce((sum, t) => sum + t.size, 0);
    this.preservedIds.set(ids);
    this.totalUsage.set(usage);
    this.preservedTracks.set(all);
  }

  // ─── internals ──────────────────────────────────────────────────────
  private async fetchTrackBlobs(
    track: Track,
    token: string,
  ): Promise<{ audioBlob: Blob; coverBlob: Blob | null; format: string } | null> {
    const audioRes = await fetch(this.server.streamUrl(track.id, token));
    if (!audioRes.ok) return null;
    const audioBlob = await audioRes.blob();

    let coverBlob: Blob | null = null;
    if (track.coverArt) {
      try {
        const coverRes = await fetch(
          this.server.apiUrl(`/api/cover/${track.coverArt}?size=600&token=${token}`),
        );
        if (coverRes.ok) coverBlob = await coverRes.blob();
      } catch {
        /* ignore cover failures */
      }
    }
    return { audioBlob, coverBlob, format: audioRes.headers.get('content-type') ?? 'audio/mpeg' };
  }

  private async storeTrack(
    track: Track,
    blobs: { audioBlob: Blob; coverBlob: Blob | null; format: string },
    source: PreserveSource,
  ): Promise<void> {
    const now = Date.now();
    const meta: PreservedTrackMeta = {
      id: track.id,
      title: track.title,
      artist: track.artist,
      album: track.album ?? '',
      coverArt: track.coverArt,
      duration: track.duration,
      bitRate: track.bitRate,
      size: blobs.audioBlob.size,
      format: blobs.format,
      preservedAt: now,
      lastAccessedAt: now,
      source,
    };
    await this.db.preserve(meta, blobs.audioBlob, blobs.coverBlob);
    this.preservedIds.update((s) => new Set(s).add(track.id));
  }

  private setBatch(key: string, b: PreserveBatch): void {
    this.batches.update((m) => new Map(m).set(key, b));
  }

  private updateBatch(key: string, fn: (b: PreserveBatch) => PreserveBatch): void {
    this.batches.update((m) => {
      const cur = m.get(key);
      if (!cur) return m;
      return new Map(m).set(key, fn(cur));
    });
  }

  private bumpBatch(key: string): void {
    this.updateBatch(key, (b) => ({ ...b, done: b.done + 1 }));
  }

  private clearBatch(key: string): void {
    this.batches.update((m) => {
      if (!m.has(key)) return m;
      const n = new Map(m);
      n.delete(key);
      return n;
    });
  }

  private clearPreserving(id: string): void {
    this.preserving.update((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
  }
}

function loadBudget(): number {
  try {
    const raw = localStorage.getItem(BUDGET_STORAGE_KEY);
    const n = raw ? Number(raw) : NaN;
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    /* ignore */
  }
  return DEFAULT_BUDGET;
}

function loadAutoPreserveMode(): AutoPreserveMode {
  try {
    const raw = localStorage.getItem(AUTO_PRESERVE_STORAGE_KEY);
    if (raw && VALID_AUTO_MODES.has(raw as AutoPreserveMode)) return raw as AutoPreserveMode;
  } catch {
    /* ignore */
  }
  return 'off';
}