import { Component, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import { TransferService } from '../../services/transfer.service';
import { PullToRefreshService } from '../../services/pull-to-refresh.service';
import { ToastService } from '../../services/toast.service';
import { TranslateService } from '../../services/translate.service';
import { httpErrorMessage } from '../../lib/http-error';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import type { AcquireJob } from '@nicotind/core';
import {
  type DownloadItem,
  buildDownloadFeed,
  mergeAcquisitionJobs,
} from '../../lib/download-groups';
import { DownloadItemComponent } from '../../components/download-item/download-item.component';
import { DiskPillComponent } from '../../components/disk-pill/disk-pill.component';
import { ReviewInboxComponent } from '../../components/review-inbox/review-inbox.component';
import { MetadataFixModalComponent } from '../../components/metadata-fix-modal/metadata-fix-modal.component';
import { DownloadReviewService } from '../../services/download-review.service';
import type { DiskUsage, ReviewQueueAlbum } from '../../services/api/api-types';

const ACQUIRE_STATE_ORDER: Record<AcquireJob['state'], number> = {
  running: 0,
  queued: 1,
  failed: 2,
  done: 3,
};

function sortAcquireJobs(jobs: AcquireJob[]): AcquireJob[] {
  return [...jobs].sort((a, b) => ACQUIRE_STATE_ORDER[a.state] - ACQUIRE_STATE_ORDER[b.state]);
}

// ─── Component ──────────────────────────────────────────────────────
// The Downloads page is now a single Active-feed view (the unified slskd +
// URL-acquisition feed). "Recently added" moved to the Library "Songs" tab and
// "Saved Offline" browsing moved to that tab's offline variant.

@Component({
  selector: 'app-downloads',
  imports: [
    ConfirmDialogComponent,
    DownloadItemComponent,
    DiskPillComponent,
    ReviewInboxComponent,
    MetadataFixModalComponent,
  ],
  templateUrl: './downloads.component.html',
})
export class DownloadsComponent {
  private api = inject(DownloadsApiService);
  private systemApi = inject(SystemApiService);
  private transferService = inject(TransferService);
  private readonly p2r = inject(PullToRefreshService);
  private readonly review = inject(DownloadReviewService);
  private readonly toasts = inject(ToastService);
  private readonly i18n = inject(TranslateService);

  readonly retrying = signal(new Set<string>());
  /** Feed keys with a cancel request in flight (#806) — the `retrying` pattern.
   *  Only covers the request round-trip: the very next poll returns the durable
   *  `cancelRequested` marker, which survives reloads. */
  readonly cancelling = signal(new Set<string>());
  readonly scanning = signal(false);

  // Download inbox triage (issue #411): the review-inbox's "Fix metadata"
  // action opens the fix modal in review mode against this album.
  readonly fixAlbum = signal<ReviewQueueAlbum | null>(null);

  onFixRequested(album: ReviewQueueAlbum): void {
    this.fixAlbum.set(album);
  }

  /** A retag re-mints the album id, so the fixed album reappears as a new
   *  pending entry — refresh the queue and close so it doesn't show a now-stale
   *  albumId in place. */
  async onTracksSaved(): Promise<void> {
    this.fixAlbum.set(null);
    await this.review.refresh();
  }

  /** A plain metadata apply (artist/album/cover/year) can also re-point the
   *  album; refresh the queue so it reflects the corrected entry too. */
  async onFixApplied(_result: { albumId: string }): Promise<void> {
    this.fixAlbum.set(null);
    await this.review.refresh();
  }

  // Storage pill for the header — best-effort; hidden if the disk read fails.
  readonly diskUsage = signal<DiskUsage | null>(null);

  constructor() {
    this.p2r.register(() => this.transferService.kickPoll());
    firstValueFrom(this.systemApi.getDiskUsage())
      .then((d) => this.diskUsage.set(d))
      .catch(() => {
        /* disk usage is non-essential; leave the pill hidden */
      });
  }

  // Confirm dialog. The optional checkbox (#810: "also discard the N tracks
  // already downloaded") is projected into the dialog's ng-content by this
  // page's template — the shared component stays a plain two-button confirm.
  readonly confirmMessage = signal('');
  readonly confirmCallback = signal<((optionChecked: boolean) => void | Promise<void>) | null>(
    null,
  );
  readonly confirmOptionLabel = signal<string | null>(null);
  readonly confirmOptionChecked = signal(false);
  readonly showConfirm = computed(() => this.confirmCallback() !== null);

  private askConfirm(
    message: string,
    cb: (optionChecked: boolean) => void | Promise<void>,
    optionLabel?: string,
  ): void {
    this.confirmMessage.set(message);
    this.confirmOptionLabel.set(optionLabel ?? null);
    this.confirmOptionChecked.set(false);
    this.confirmCallback.set(cb);
  }

  onConfirm(): void {
    const cb = this.confirmCallback();
    const checked = this.confirmOptionChecked();
    this.confirmCallback.set(null);
    this.confirmOptionLabel.set(null);
    Promise.resolve(cb?.(checked)).catch(() => {
      /* ignore */
    });
  }

  onCancelConfirm(): void {
    this.confirmCallback.set(null);
    this.confirmOptionLabel.set(null);
  }

  // Computed — acquire jobs (the finished buckets drive "Clear finished").
  readonly sortedAcquireJobs = computed(() => sortAcquireJobs(this.transferService.acquireJobs()));
  readonly failedAcquireJobs = computed(() =>
    this.sortedAcquireJobs().filter((j) => j.state === 'failed'),
  );
  readonly doneAcquireJobs = computed(() =>
    this.sortedAcquireJobs().filter((j) => j.state === 'done'),
  );

  // Unified Active-tab feed: slskd groups + acquire jobs as one sorted list,
  // then the unified acquisition jobs folded in (post-download stages:
  // organizing → scanning → processing → done, honest-partial unavailable
  // counts, and job rows whose transfers vanished from slskd).
  readonly downloadFeed = computed(() =>
    mergeAcquisitionJobs(
      buildDownloadFeed(this.transferService.acquireJobs()),
      this.transferService.acquisitionJobs(),
    ),
  );
  readonly activeFeedCount = computed(
    () => this.downloadFeed().filter((i) => i.stage !== 'done' && i.stage !== 'error').length,
  );
  readonly clearableFeedCount = computed(
    () => this.downloadFeed().filter((i) => i.stage === 'done' || i.stage === 'error').length,
  );

  // Re-enqueue the failed tracks of a group. slskd resumes the partial files,
  // and the retried transfers get a fresh auto-retry budget on the server.

  async triggerScan(): Promise<void> {
    if (this.scanning()) return;
    this.scanning.set(true);
    try {
      await firstValueFrom(this.systemApi.triggerScan());
    } catch {
      /* ignore */
    } finally {
      this.scanning.set(false);
    }
  }

  // ─── Unified feed dispatch (routes a DownloadItem action to its source) ───

  /**
   * A network card is a unified job (the raw transfers lane is gone —
   * phase 3): its actions go to the job endpoints, resolved to the owning
   * addon server-side. URL cards keep their acquire-job actions.
   */

  onItemRetry(item: DownloadItem): void {
    if (item.kind !== 'network') {
      const j = this.transferService.acquireJobs().find((x) => x.id === item.key);
      if (j) void this.retryAcquireJob(j);
      return;
    }
    // An addon-run URL acquire renders in the network lane but retries through
    // the acquire endpoint (which re-submits the stored link). Without this the
    // Retry button would render and do nothing.
    if (item.jobId) void this.retryJobById(item.jobId, item.key);
  }

  onItemCancel(item: DownloadItem): void {
    if (item.kind === 'network') {
      if (!item.jobId) return;
      const jobId = item.jobId;
      const landed = item.progress?.done ?? 0;
      // Nothing landed yet → cancel stays one friction-free click. With tracks
      // already on disk, cancelling is also the moment to decide their fate
      // (#810) — default keep: they go to review, discard is the opt-in.
      if (landed === 0) {
        void this.cancelJob(jobId, item.key);
        return;
      }
      this.askConfirm(
        this.i18n.t('downloads.cancelConfirm'),
        async (discard) => {
          await this.cancelJob(jobId, item.key);
          if (discard) await this.discardPartial(jobId);
        },
        this.i18n.t('downloads.cancelAlsoDiscard', { count: landed }),
      );
    } else {
      const j = this.transferService.acquireJobs().find((x) => x.id === item.key);
      if (j) void this.dismissAcquireJob(j);
    }
  }

  /** Card action on a held partial (#810): throw this job's landed tracks away. */
  onItemDiscardPartial(item: DownloadItem): void {
    if (!item.jobId) return;
    const jobId = item.jobId;
    this.askConfirm(
      this.i18n.t('downloads.discardPartialConfirm', { count: item.quarantinedCount ?? 0 }),
      () => this.discardPartial(jobId),
    );
  }

  /** "Review" on a held partial: the inbox is on this same page — jump to it. */
  onItemReviewJump(): void {
    document.querySelector('[data-testid="review-inbox"]')?.scrollIntoView({ behavior: 'smooth' });
  }

  private async discardPartial(jobId: string): Promise<void> {
    try {
      await firstValueFrom(this.api.discardPartial(jobId));
      this.transferService.markLibraryDirty();
      await this.review.refresh();
    } catch (err) {
      this.toasts.show({
        message: httpErrorMessage(err, this.i18n.t('downloads.discardPartialFailed')),
        kind: 'error',
      });
    }
    await this.transferService.kickPoll();
  }

  onItemRemove(item: DownloadItem): void {
    if (item.kind === 'network') {
      if (item.jobId) {
        this.askConfirm('Remove this download from the feed?', async () => {
          // Surface a failed removal (issue #533) — swallowing it here is how
          // "old downloads I can't remove" shipped without a single error.
          try {
            await firstValueFrom(this.api.deleteJob(item.jobId!));
          } catch (err) {
            this.toasts.show({
              message: httpErrorMessage(err, 'Could not remove this download'),
              kind: 'error',
            });
          }
          await this.transferService.kickPoll();
        });
      }
    } else {
      const j = this.transferService.acquireJobs().find((x) => x.id === item.key);
      if (j) void this.dismissAcquireJob(j);
    }
  }

  private async cancelJob(jobId: string, feedKey: string): Promise<void> {
    // Same guard shape as `retryJobById` — the asymmetry (Retry had it, Cancel
    // didn't) is what let re-clicks re-fire the cancel forever (#806).
    if (this.cancelling().has(feedKey)) return;
    this.cancelling.update((prev) => new Set(prev).add(feedKey));
    try {
      await firstValueFrom(this.api.cancelJob(jobId));
    } catch (err) {
      // Swallowing this is how "the X does nothing" shipped (same shape as
      // #533's removal fix) — a cancel against an already-released addon job
      // 502s, and the user deserves to know rather than clicking again.
      this.toasts.show({
        message: httpErrorMessage(err, 'Could not cancel this download'),
        kind: 'error',
      });
    } finally {
      this.cancelling.update((prev) => {
        const next = new Set(prev);
        next.delete(feedKey);
        return next;
      });
      await this.transferService.kickPoll();
    }
  }

  /**
   * Retry a unified-feed job by id (addon URL acquires; see `onItemRetry`).
   *
   * `feedKey` is separate from `jobId` on purpose: the template asks
   * `retrying().has(item.key)`, and a network-lane item's key is
   * `job:<id>`, not the bare id. Registering the id here meant the two never
   * matched, so Retry stayed enabled through the whole resolve window — which
   * is what made #714's server-side race trivially reachable by clicking.
   */
  private async retryJobById(jobId: string, feedKey: string): Promise<void> {
    if (this.retrying().has(feedKey)) return;
    this.retrying.update((prev) => new Set(prev).add(feedKey));
    try {
      await firstValueFrom(this.api.retryAcquireJob(jobId));
    } catch (err) {
      this.toasts.show({
        message: httpErrorMessage(err, 'Could not retry this download'),
        kind: 'error',
      });
    } finally {
      this.retrying.update((prev) => {
        const next = new Set(prev);
        next.delete(feedKey);
        return next;
      });
      await this.transferService.kickPoll();
    }
  }

  /** Cancel every in-flight card: addon jobs via their job endpoint, URL
   *  acquire jobs via their delete. Only genuinely cancellable rows (#806):
   *  the old any-non-terminal filter re-fired at `processing` jobs — which
   *  have nothing left to cancel — on every click. */
  async cancelAll(): Promise<void> {
    const active = this.downloadFeed().filter((i) => i.canCancel && !i.cancelRequested);
    await Promise.all(
      active.map((i) =>
        i.kind === 'network' && i.jobId
          ? firstValueFrom(this.api.cancelJob(i.jobId)).catch(() => {})
          : Promise.resolve(),
      ),
    );
    await this.transferService.kickPoll();
  }

  /** Clear finished/errored cards from the feed on both sides. */
  async clearAllFinished(): Promise<void> {
    const finished = this.downloadFeed().filter((i) => i.stage === 'done' || i.stage === 'error');
    let failures = 0;
    await Promise.all(
      finished.map((i) =>
        i.kind === 'network' && i.jobId
          ? firstValueFrom(this.api.deleteJob(i.jobId)).catch(() => {
              failures++;
            })
          : Promise.resolve(),
      ),
    );
    const toClear = [...this.failedAcquireJobs(), ...this.doneAcquireJobs()];
    await Promise.all(
      toClear.map((j) =>
        firstValueFrom(this.api.deleteAcquireJob(j.id)).catch(() => {
          failures++;
        }),
      ),
    );
    // One aggregate toast, not one per row — but never silence (issue #533).
    if (failures > 0) {
      this.toasts.show({
        message: `Could not clear ${failures} ${failures === 1 ? 'download' : 'downloads'}`,
        kind: 'error',
      });
    }
    await this.transferService.kickPoll();
  }

  // ─── Acquire job actions ─────────────────────────────────────────

  async dismissAcquireJob(job: AcquireJob): Promise<void> {
    try {
      await firstValueFrom(this.api.deleteAcquireJob(job.id));
    } catch {
      /* ignore */
    }
    this.transferService.kickPoll();
  }

  async retryAcquireJob(job: AcquireJob): Promise<void> {
    this.retrying.update((prev) => new Set(prev).add(job.id));
    try {
      await firstValueFrom(this.api.retryAcquireJob(job.id));
    } catch {
      /* ignore */
    } finally {
      this.retrying.update((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
      this.transferService.kickPoll();
    }
  }
}
