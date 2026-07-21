import { Injectable, computed, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { firstValueFrom } from 'rxjs';
import { SystemApiService } from './api/system-api.service';
import type { BackupInfo, ServiceReview } from './api/api-types';

/**
 * ServiceReview — singleton owner of the Admin page's one read-only snapshot.
 *
 * Every sub-section on the Admin page (System header, versions, library
 * scan, backups, audit tail, incomplete-albums count, untracked count,
 * processing summary, **hardware metrics**) consumes this service via
 * computed slices instead of polling its own endpoint and managing its own
 * signal. Pages call `start()` on entry / `stop()` on teardown; the timer
 * pauses while the tab is hidden (Page Visibility API) and is re-entrant so
 * concurrent consumers share one timer. A network blip never tears down the
 * current snapshot — `refresh()` swallows errors and the chip row simply goes
 * grey until the next tick succeeds. See `docs/design-patterns.md`
 * "ServiceReview".
 */
@Injectable({ providedIn: 'root' })
export class ServiceReviewService {
  private api = inject(SystemApiService);

  /** 5 s poll cadence while at least one consumer owns the timer. */
  static readonly POLL_MS = 5_000;

  /** The latest snapshot. Stays populated across transient HTTP failures. */
  readonly review = signal<ServiceReview | null>(null);
  /** Last HTTP error the poll swallowed (for diagnostics surfaces only). */
  readonly lastError = signal<string | null>(null);
  /** True while `refresh()` is in flight. */
  readonly loading = signal(false);
  /** True while at least one consumer owns the timer. */
  readonly active = signal(false);

  // --- Computed slices ────────────────────────────────────────────────────────
  // Every Admin sub-section reads from these instead of declaring its own
  // loader signals. Mirrors the API field-for-field so the migration is a
  // search-and-replace with no semantic change in the template.

  readonly lastUpdatedAt = computed(() => this.review()?.collectedAt ?? null);
  readonly hasErrors = computed(() => (this.review()?.errors.length ?? 0) > 0);
  readonly errors = computed(() => this.review()?.errors ?? []);

  // Hardware / load
  readonly cpu = computed(() => this.review()?.load.cpu);
  readonly memory = computed(() => this.review()?.load.memory);
  /** Null on hosts where no vendor CLI exposes utilisation; drives the GPU pill's hide. */
  readonly gpu = computed(() => this.review()?.load.gpu);
  readonly hardware = computed(() => this.review()?.hardware);

  // Service state
  readonly services = computed(() => this.review()?.services);

  // Library
  readonly libraryState = computed(() => this.review()?.library);

  // Update / backups
  readonly updateCheck = computed(() => this.review()?.updateCheck);
  /** Full backup list (newest first) — used by the Admin backups table. */
  readonly backups = computed<BackupInfo[]>(() => this.review()?.backups ?? []);
  /** Compact chip-level summary for the collapsed panel header. */
  readonly backupsSummary = computed(() => this.review()?.backupsSummary);

  // Processing (summary only; the SSE stream is on its own endpoint)
  readonly processingState = computed(() => this.review()?.processing);

  // Counts that used to live on their own endpoints
  readonly incompleteJobsCount = computed(() => this.review()?.incompleteJobsCount ?? 0);
  readonly untrackedCount = computed(() => this.review()?.untrackedCount ?? 0);
  readonly auditTail = computed(() => this.review()?.auditTail ?? []);
  /** Snapshots of the Admin tables — drained from ServiceReview instead of polled per-table. */
  readonly incompleteJobs = computed(() => this.review()?.incompleteJobs ?? []);
  readonly untracked = computed(() => this.review()?.untracked ?? []);

  // Version + uptime
  readonly version = computed(() => this.review()?.version ?? null);
  readonly uptimeMs = computed(() => this.review()?.uptimeMs ?? 0);

  /** Per-version summary; back-compat alias used by `getStatus`-style call sites. */
  readonly versionLine = computed(() => {
    const r = this.review();
    return r ? { version: r.version, uptimeMs: r.uptimeMs } : null;
  });

  // --- Lifecycle: ref-counted timer + Page Visibility pause ───────────────────

  private ownerCount = 0;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private inflight: Promise<void> | null = null;
  private visibilityListener?: () => void;
  private readonly refreshSubject = new Subject<void>();
  /** Emits one tick per refresh attempt (success or swallow). */
  readonly refresh$ = this.refreshSubject.asObservable();

  /**
   * Begin polling. Re-entrant — call once per owning component, the timer
   * stays alive until the matching number of `stop()` calls. Returns a
   * `dispose()` closure for the common ergonomics pattern.
   */
  start(): () => void {
    this.ownerCount += 1;
    this.active.set(true);
    this.ensureTimerRunning();
    this.attachVisibilityIfNeeded();
    // Kick an immediate fetch so the page never renders an empty Admin panel.
    void this.refresh();
    return () => this.stop();
  }

  /** Stop polling; the timer is cleared when the last owner leaves. */
  stop(): void {
    if (this.ownerCount <= 0) return;
    this.ownerCount -= 1;
    if (this.ownerCount === 0) {
      this.active.set(false);
      this.detachVisibility();
      if (this.intervalId !== null) {
        clearInterval(this.intervalId);
        this.intervalId = null;
      }
    }
  }

  /**
   * One-shot fetch. Coalesces parallel callers — a second `refresh()` while
   * one is in flight shares the same `Promise` so eight `effect()`s all
   * triggered at once still produce one HTTP request. Swallows every error
   * so a transient 5xx never tears down the snapshot.
   */
  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight;
    this.loading.set(true);
    this.inflight = (async () => {
      try {
        const r = await firstValueFrom(this.api.getServiceReview());
        this.review.set(r);
        this.lastError.set(null);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.lastError.set(msg);
        // Keep the last-known snapshot; the UI degrades gracefully.
      } finally {
        this.loading.set(false);
        this.inflight = null;
        this.refreshSubject.next();
      }
    })();
    return this.inflight;
  }

  // --- internal: timer + visibility ──────────────────────────────────────────

  private ensureTimerRunning(): void {
    if (this.intervalId !== null) return;
    this.intervalId = setInterval(() => {
      // Tab may have flipped hidden between ticks; skip a wasted fetch.
      if (this.isPageVisible()) void this.refresh();
    }, ServiceReviewService.POLL_MS);
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
        // Resume — re-arm the timer + fire one immediate catch-up.
        this.ensureTimerRunning();
        void this.refresh();
      } else if (this.intervalId !== null) {
        // Pause — clear the interval but keep the last snapshot for when
        // the user returns. `start()` will re-arm.
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
