import { Component, inject, signal, computed } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import { SystemApiService } from '../../services/api/system-api.service';
import { TransferService } from '../../services/transfer.service';
import { ConfirmDialogComponent } from '../../components/confirm-dialog/confirm-dialog.component';
import type { AcquireJob } from '@nicotind/core';
import {
  type AlbumGroup,
  type DownloadItem,
  groupByAlbum,
  buildDownloadFeed,
  mergeAcquisitionJobs,
} from '../../lib/download-groups';
import { DownloadItemComponent } from '../../components/download-item/download-item.component';

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
  imports: [ConfirmDialogComponent, DownloadItemComponent],
  templateUrl: './downloads.component.html',
})
export class DownloadsComponent {
  private api = inject(DownloadsApiService);
  private systemApi = inject(SystemApiService);
  private transferService = inject(TransferService);

  readonly retrying = signal(new Set<string>());
  readonly scanning = signal(false);

  // Confirm dialog
  readonly confirmMessage = signal('');
  readonly confirmCallback = signal<(() => void | Promise<void>) | null>(null);
  readonly showConfirm = computed(() => this.confirmCallback() !== null);

  private askConfirm(message: string, cb: () => void): void {
    this.confirmMessage.set(message);
    this.confirmCallback.set(cb);
  }

  onConfirm(): void {
    const cb = this.confirmCallback();
    this.confirmCallback.set(null);
    Promise.resolve(cb?.()).catch(() => {
      /* ignore */
    });
  }

  onCancelConfirm(): void {
    this.confirmCallback.set(null);
  }

  // Computed — slskd transfers
  readonly groups = computed(() => groupByAlbum(this.transferService.downloads()));

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
      buildDownloadFeed(this.groups(), this.transferService.acquireJobs()),
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
  async retryGroup(group: AlbumGroup): Promise<void> {
    const ids = group.erroredFileIds;
    if (!ids.length) return;
    this.retrying.update((prev) => new Set(prev).add(group.key));
    try {
      await firstValueFrom(
        this.api.retryDownloads(ids.map((id) => ({ username: group.username, id }))),
      );
    } catch {
      /* ignore */
    } finally {
      this.retrying.update((prev) => {
        const next = new Set(prev);
        next.delete(group.key);
        return next;
      });
      this.transferService.kickPoll();
    }
  }

  async clearGroup(group: AlbumGroup): Promise<void> {
    await Promise.all(
      group.fileIds.map((id) =>
        firstValueFrom(this.api.cancelDownload(group.username, id)).catch(() => {}),
      ),
    );
    this.transferService.kickPoll();
  }

  async clearAllFinished(): Promise<void> {
    try {
      await firstValueFrom(this.api.cancelAllFinished());
    } catch {
      /* ignore */
    }
    // Also clear all done/failed acquire jobs
    const toClear = [...this.failedAcquireJobs(), ...this.doneAcquireJobs()];
    await Promise.all(
      toClear.map((j) => firstValueFrom(this.api.deleteAcquireJob(j.id)).catch(() => {})),
    );
    this.transferService.kickPoll();
  }

  async cancelAll(): Promise<void> {
    try {
      await firstValueFrom(this.api.cancelAllDownloads());
    } catch {
      /* ignore */
    }
    this.transferService.kickPoll();
  }

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

  removeGroup(group: AlbumGroup): void {
    this.askConfirm(`Remove "${group.name}" and all its ${group.totalFiles} file(s)?`, async () => {
      await Promise.all(
        group.fileIds.map((id) =>
          firstValueFrom(this.api.cancelDownload(group.username, id)).catch(() => {}),
        ),
      );
      this.transferService.kickPoll();
    });
  }

  // ─── Unified feed dispatch (routes a DownloadItem action to its source) ───

  /**
   * The slskd folder groups behind a feed card. A collapsed card (one album
   * spread over several peers/subfolders) carries every member's key, so
   * actions fan out to all of them.
   */
  private groupsForItem(item: DownloadItem): AlbumGroup[] {
    const keys = new Set(item.memberKeys ?? [item.key]);
    return this.groups().filter((g) => keys.has(g.key));
  }

  onItemRetry(item: DownloadItem): void {
    if (item.kind === 'slskd') {
      for (const g of this.groupsForItem(item)) void this.retryGroup(g);
    } else {
      const j = this.transferService.acquireJobs().find((x) => x.id === item.key);
      if (j) void this.retryAcquireJob(j);
    }
  }

  onItemCancel(item: DownloadItem): void {
    if (item.kind === 'slskd') {
      for (const g of this.groupsForItem(item)) void this.clearGroup(g);
    } else {
      const j = this.transferService.acquireJobs().find((x) => x.id === item.key);
      if (j) void this.dismissAcquireJob(j);
    }
  }

  onItemRemove(item: DownloadItem): void {
    if (item.kind === 'slskd') {
      for (const g of this.groupsForItem(item)) this.removeGroup(g);
    } else {
      const j = this.transferService.acquireJobs().find((x) => x.id === item.key);
      if (j) void this.dismissAcquireJob(j);
    }
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
