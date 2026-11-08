import { Injectable, inject, signal } from '@angular/core';
import {
  DEFAULT_BUDGET,
  type PreservedTrackMeta,
  type PreserveSource,
} from '../lib/preserve-store';
import type { Track } from './player.service';
import { AuthService } from './auth.service';
import { ServerConfigService } from './server-config.service';
import { haptic } from '../lib/haptics';
import { songCover } from '../lib/cover-url';
import { CoverRevisionsService } from './cover-revisions.service';
import { PreservedCoversService } from './preserved-covers.service';
import { PRESERVE_STORE } from './preserve-store.token';
import { LyricsService } from './lyrics.service';

// The store token lives in its own module so LyricsService can read the
// preserved lyrics without importing this service (#1751).
export { PRESERVE_STORE, type PreserveStore } from './preserve-store.token';

/** Sentinel "no cap" budget — large enough that the projected-usage check never trips. */
export const UNLIMITED_BUDGET = Number.MAX_SAFE_INTEGER;

const BUDGET_STORAGE_KEY = 'nicotind-preserve-budget';
const AUTO_PRESERVE_STORAGE_KEY = 'nicotind-auto-preserve';

/**
 * Auto-preserve window — how far ahead of the playhead to keep on disk.
 *
 * `'1'` is the data-saver rung: only the track actually playing is kept, so
 * offline playback survives a locked screen without a metered connection paying
 * for a queue nobody asked for (#1263). Before it, the smallest way to have
 * offline playback at all was five tracks ahead.
 */
export type AutoPreserveMode = 'off' | '1' | '5' | '20' | 'full';

/** Hard cap on the "full" window so a runaway radio can't fill 50 GB. */
const AUTO_PRESERVE_FULL_CAP = 200;
/** Concurrency limit for auto-preserve fetches — bounds memory + parallel network. */
export const AUTO_PRESERVE_CONCURRENCY = 3;
/**
 * How long a track whose auto-preserve fetch failed is left alone before the
 * coordinator may ask for it again. A failure is cheap to produce (offline,
 * the fetch rejects in milliseconds; a 404 answers just as fast), so without
 * this every queue mutation re-fetched every broken track in the window.
 */
export const AUTO_PRESERVE_RETRY_MS = 60_000;

/** What one preserve attempt did: `skipped` (already saved, in flight, no token) is not a failure. */
type PreserveOutcome = 'stored' | 'skipped' | 'failed';

/** Live progress for an in-flight collection ("Download album/playlist/genre") preserve. */
export interface PreserveBatch {
  /** Collection name (album/playlist/genre) — used to scope UI notices to the originating page. */
  name: string;
  done: number;
  total: number;
  /** True when the batch stopped because the storage budget filled up. */
  stoppedAtCap: boolean;
}

const VALID_AUTO_MODES = new Set<AutoPreserveMode>(['off', '1', '5', '20', 'full']);

/**
 * Store-time integrity gate for a fetched audio body. A `fetch` that is cut
 * short by a proxy/network drop can resolve with a truncated blob instead of
 * rejecting (an intermediary that ends the stream cleanly — e.g. an HTTP/2
 * reverse proxy losing its backend — looks like a normal EOF to the browser).
 * Persisting that body poisons IndexedDB: the player then sources a 3-4 s
 * "track" from the blob on every future play, long after the network recovered.
 * Reject an empty body outright, and any body whose byte count disagrees with
 * the response's own Content-Length. A missing/unreadable header (older
 * server, CORS not exposing it) skips the comparison rather than rejecting.
 */
export function preservedAudioLooksComplete(
  blobSize: number,
  contentLength: string | null,
): boolean {
  if (!(blobSize > 0)) return false;
  const expected = contentLength == null ? NaN : Number(contentLength);
  if (Number.isFinite(expected) && expected > 0 && blobSize !== expected) return false;
  return true;
}

@Injectable({ providedIn: 'root' })
export class PreserveService {
  private auth = inject(AuthService);
  private server = inject(ServerConfigService);
  private coverRevisions = inject(CoverRevisionsService);
  private db = inject(PRESERVE_STORE);
  private preservedCovers = inject(PreservedCoversService);
  private lyrics = inject(LyricsService);

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

  /**
   * The one auto-preserve work queue, shared by every `ensureAutoPreservedFor`
   * call. Plain fields, not signals: nothing renders them, and a signal here
   * would be one more thing the coordinator's effect could accidentally track.
   */
  private autoQueue: Track[] = [];
  private autoWorkers = 0;
  /** Track id → when its last auto-preserve fetch failed (see AUTO_PRESERVE_RETRY_MS). */
  private readonly autoFailedAt = new Map<string, number>();

  async init(): Promise<void> {
    // Binding the store loads the preserved covers (#1658); refreshList keeps
    // them in step with every later preserve / remove.
    this.preservedCovers.attach(this.db);
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
   * 'off' disables auto-preserve. '1' keeps only what is playing right now.
   * '5'/'20' cap at the window size or queue length, whichever is smaller.
   * 'full' is bounded by AUTO_PRESERVE_FULL_CAP so a runaway radio never fills
   * tens of GB.
   */
  windowSize(trackCount: number): number {
    if (trackCount <= 0) return 0;
    switch (this.autoPreserveMode()) {
      case 'off':
        return 0;
      case '1':
        return 1;
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
    // The person asked for this one, so its landing (or not) is felt; the
    // auto path below is background work and stays silent.
    const outcome = await this.preserveWithSource(track, 'user');
    if (outcome === 'stored') haptic('success');
    else if (outcome === 'failed') haptic('error');
  }

  /**
   * Auto-preserve variant — same fetch + store path but tags the row as
   * `source: 'auto'` so the eviction policy treats it as cheap-to-lose.
   * Idempotent: re-entry and already-preserved guards mirror `preserve()`.
   */
  async autoPreserve(track: Track): Promise<void> {
    await this.preserveWithSource(track, 'auto');
  }

  private async preserveWithSource(track: Track, source: PreserveSource): Promise<PreserveOutcome> {
    const token = this.auth.token();
    if (!token || this.preserving().has(track.id) || this.preservedIds().has(track.id)) {
      return 'skipped';
    }

    this.preserving.update((s) => new Set(s).add(track.id));
    try {
      const blobs = await this.fetchTrackBlobs(track, token);
      if (!blobs) return 'failed';
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
      return 'stored';
    } catch {
      // Swallow — failure leaves the track un-preserved.
      return 'failed';
    } finally {
      this.clearPreserving(track.id);
    }
  }

  /**
   * Idempotent batch entry point for the auto-preserve coordinator. Skips any
   * track already preserved, in flight, or inside its failure backoff.
   *
   * The latest window wins: `tracks` REPLACES whatever was still waiting, so a
   * skip-ahead stops fetching tracks that left the window. Every call feeds the
   * one shared queue, drained by at most AUTO_PRESERVE_CONCURRENCY workers in
   * total — per-call workers multiplied the cap by the number of calls, and the
   * coordinator calls on every queue mutation. Resolves once the workers THIS
   * call started are done; a call that only refilled the queue resolves at once.
   */
  async ensureAutoPreservedFor(tracks: Track[]): Promise<void> {
    if (this.autoPreserveMode() === 'off') return;
    if (!this.auth.token()) return;

    const now = Date.now();
    this.autoQueue = tracks.filter(
      (t) =>
        t &&
        !this.preservedIds().has(t.id) &&
        !this.preserving().has(t.id) &&
        !this.inAutoBackoff(t.id, now),
    );

    const started: Promise<void>[] = [];
    while (this.autoWorkers < AUTO_PRESERVE_CONCURRENCY && this.autoQueue.length > 0) {
      started.push(this.runAutoWorker());
    }
    await Promise.all(started);
  }

  /**
   * Let every track that failed to auto-preserve be asked for again now. The
   * coordinator calls this on reconnect: a failure from before the app noticed
   * it was offline says nothing about the network that just came back.
   */
  forgetAutoPreserveFailures(): void {
    this.autoFailedAt.clear();
  }

  private inAutoBackoff(id: string, now: number): boolean {
    const failedAt = this.autoFailedAt.get(id);
    return failedAt !== undefined && now - failedAt < AUTO_PRESERVE_RETRY_MS;
  }

  private async runAutoWorker(): Promise<void> {
    this.autoWorkers++;
    try {
      for (let next = this.autoQueue.shift(); next; next = this.autoQueue.shift()) {
        // Turning auto-preserve off stops the downloads, including queued ones.
        if (this.autoPreserveMode() === 'off') {
          this.autoQueue = [];
          return;
        }
        const outcome = await this.preserveWithSource(next, 'auto');
        if (outcome === 'failed') this.autoFailedAt.set(next.id, Date.now());
        else if (outcome === 'stored') this.autoFailedAt.delete(next.id);
      }
    } finally {
      this.autoWorkers--;
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
          await this.storeTrack(track, blobs, 'user');
          this.totalUsage.update((u) => u + blobs.audioBlob.size);
          this.bumpBatch(key);
        } catch {
          // `fetchTrackBlobs` rejects with a TypeError when offline (raw `fetch`).
          // Callers invoke this fire-and-forget (`void preserveCollection(...)`),
          // so an uncaught reject here would surface as an unhandled promise
          // rejection AND abort the rest of the batch. Skip this track instead.
        } finally {
          this.clearPreserving(track.id);
        }
      }
    } finally {
      await this.refreshList();
      const final = this.batches().get(key);
      // Only a batch that stored nothing failed; one that fell short stopped, like the cap.
      const done = final?.done ?? 0;
      haptic(
        final?.stoppedAtCap || (final && done > 0 && done < final.total)
          ? 'warning'
          : done > 0
            ? 'success'
            : 'error',
      );
      // Keep the final state visible when we hit the cap (drives the "limit reached"
      // notice); otherwise clear so the button returns to its resting state.
      if (!final?.stoppedAtCap) this.clearBatch(key);
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
    // Every remove / evict / clear path ends here: the covers follow the rows.
    void this.preservedCovers.refresh();
  }

  // ─── internals ──────────────────────────────────────────────────────
  private async fetchTrackBlobs(
    track: Track,
    token: string,
  ): Promise<{ audioBlob: Blob; coverBlob: Blob | null; format: string } | null> {
    const audioRes = await fetch(this.server.streamUrl(track.id, token));
    if (!audioRes.ok) return null;
    const audioBlob = await audioRes.blob();
    // A truncated body must not reach IndexedDB — a stored bad blob replays
    // identically on every play until evicted (see preservedAudioLooksComplete).
    if (!preservedAudioLooksComplete(audioBlob.size, audioRes.headers.get('content-length'))) {
      return null;
    }

    let coverBlob: Blob | null = null;
    const cover = this.coverRevisions.url(songCover(track), 600, token);
    if (cover) {
      try {
        // The blob is kept for good, so it must be the current bytes: the rev'd
        // URL, and a revalidation in case the browser holds a stale copy of
        // even that (a rev-0 cover replaced on disk) (#1666).
        const coverRes = await fetch(this.server.apiUrl(cover), { cache: 'no-cache' });
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
      coverRev: track.coverRev,
      albumId: track.albumId,
      artistId: track.artistId,
      artists: track.artists,
      genre: track.genre,
      duration: track.duration,
      bitRate: track.bitRate,
      size: blobs.audioBlob.size,
      format: blobs.format,
      preservedAt: now,
      lastAccessedAt: now,
      source,
    };
    // The stored lyrics ride along so karaoke works offline (#1751); a song
    // with none, or a failed read, preserves without them.
    const lyrics = await this.lyrics.snapshot(track.id).catch(() => null);
    await this.db.preserve(meta, blobs.audioBlob, blobs.coverBlob, lyrics);
    this.preservedIds.update((s) => new Set(s).add(track.id));
    void this.preservedCovers.refresh();
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
