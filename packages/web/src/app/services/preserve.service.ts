import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import * as db from '../lib/preserve-store';
import { DEFAULT_BUDGET, type PreservedTrackMeta } from '../lib/preserve-store';
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
  clearAll: typeof db.clearAll;
}

export const PRESERVE_STORE = new InjectionToken<PreserveStore>('PRESERVE_STORE', {
  providedIn: 'root',
  factory: () => db,
});

/** Sentinel "no cap" budget — large enough that the projected-usage check never trips. */
export const UNLIMITED_BUDGET = Number.MAX_SAFE_INTEGER;

const BUDGET_STORAGE_KEY = 'nicotind-preserve-budget';

/** Live progress for an in-flight collection ("Download album/playlist/genre") preserve. */
export interface PreserveBatch {
  /** Collection name (album/playlist/genre) — used to scope UI notices to the originating page. */
  name: string;
  done: number;
  total: number;
  /** True when the batch stopped because the storage budget filled up. */
  stoppedAtCap: boolean;
}

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

  async preserve(track: Track): Promise<void> {
    const token = this.auth.token();
    if (!token || this.preserving().has(track.id) || this.preservedIds().has(track.id)) return;

    this.preserving.update((s) => new Set(s).add(track.id));
    try {
      const blobs = await this.fetchTrackBlobs(track, token);
      if (!blobs) return;
      // Single-track save evicts least-recently-played tracks to make room (LRU).
      await this.db.evictLRU(blobs.audioBlob.size, this.budget());
      await this.storeTrack(track, blobs);
      await this.refreshList();
    } catch {
      /* swallow — failure leaves the track un-preserved */
    } finally {
      this.clearPreserving(track.id);
    }
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
          await this.storeTrack(track, blobs);
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
