import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ReviewApiService } from './api/review-api.service';
import { AuthService } from './auth.service';
import type { ReviewQueueAlbum } from './api/api-types';

/**
 * Download inbox triage (issue #411): the ref-counted pending-count poller
 * backing the nav badges + the (later) inbox page. Modeled on
 * `ServiceReviewService.start/stop/ensureTimerRunning/attachVisibility`
 * (`service-review.service.ts:120-142,173-204`) — a shared 30 s timer, paused
 * while the tab is hidden, re-entrant across every owning component.
 *
 * `pending` is fetched on every tick regardless of consumer (it drives the nav
 * badges everywhere); the full `queue` is a heavier fetch only needed by the
 * inbox page itself, so it's gated on a second ref-count (`watchQueue()`)
 * layered on top of the same timer — a badge-only page never pays for the
 * queue payload.
 *
 * Polling is a no-op entirely when `auth.canCurate()` is false: a listener/
 * user role can never see this queue, so there is nothing to poll for.
 */
@Injectable({ providedIn: 'root' })
export class DownloadReviewService {
  private api = inject(ReviewApiService);
  private auth = inject(AuthService);

  /** 30 s poll cadence while at least one consumer owns the timer. */
  static readonly POLL_MS = 30_000;

  readonly pending = signal(0);
  readonly queue = signal<ReviewQueueAlbum[]>([]);
  readonly loading = signal(false);

  private ownerCount = 0;
  private queueWatchers = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private visibilityListener?: () => void;

  /**
   * Begin polling. Re-entrant — call once per owning component; the timer
   * stays alive until the matching number of `stop()` calls. No-ops (never
   * arms a timer or fires a request) when the current user can't curate.
   * Returns a `dispose()` closure for the common ergonomics pattern.
   */
  start(): () => void {
    if (!this.auth.canCurate()) return () => {};
    this.ownerCount += 1;
    this.ensureTimerRunning();
    this.attachVisibilityIfNeeded();
    // Kick an immediate fetch so a fresh mount never shows a stale badge.
    void this.refresh();
    return () => this.stop();
  }

  /** Stop polling; the timer is cleared when the last owner leaves. */
  stop(): void {
    if (this.ownerCount <= 0) return;
    this.ownerCount -= 1;
    if (this.ownerCount === 0) {
      this.detachVisibility();
      if (this.intervalId !== null) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    }
  }

  /**
   * Register interest in the full `queue` payload (the inbox page). Re-entrant
   * like `start()`; returns a `stop()` closure. Does not itself start the
   * timer — pair with `start()`.
   */
  watchQueue(): () => void {
    this.queueWatchers += 1;
    void this.refresh();
    return () => {
      if (this.queueWatchers > 0) this.queueWatchers -= 1;
    };
  }

  /**
   * One-shot fetch. Coalesces parallel callers — a second `refresh()` while
   * one is in flight shares the same `Promise`. Always fetches `pending`;
   * only fetches the full `queue` when at least one `watchQueue()` consumer
   * is registered.
   */
  async refresh(): Promise<void> {
    if (!this.auth.canCurate()) return;
    if (this.inflight) return this.inflight;
    this.loading.set(true);
    this.inflight = (async () => {
      try {
        const count = await firstValueFrom(this.api.getCount());
        this.pending.set(count.pending);
        if (this.queueWatchers > 0) {
          const { albums } = await firstValueFrom(this.api.getQueue());
          this.queue.set(albums);
        }
      } catch {
        // Swallow — a transient failure keeps the last-known badge/queue
        // rather than flashing to zero/empty.
      } finally {
        this.loading.set(false);
        this.inflight = null;
      }
    })();
    return this.inflight;
  }

  // --- internal: timer + visibility ──────────────────────────────────────────

  private ensureTimerRunning(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      if (this.isPageVisible()) void this.refresh();
    }, DownloadReviewService.POLL_MS);
  }

  private isPageVisible(): boolean {
    if (typeof document === 'undefined') return true;
    return !document.hidden;
  }

  private attachVisibilityIfNeeded(): void {
    if (this.visibilityListener) return;
    if (typeof document === 'undefined') return;
    this.visibilityListener = () => {
      if (this.isPageVisible()) {
        this.ensureTimerRunning();
        void this.refresh();
      } else if (this.intervalId !== null) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    };
    document.addEventListener('visibilitychange', this.visibilityListener);
  }

  private detachVisibility(): void {
    if (this.visibilityListener && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityListener);
    }
    this.visibilityListener = undefined;
  }
}
