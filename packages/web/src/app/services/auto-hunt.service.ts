import { Injectable, computed, effect, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService, type ToastAction } from './toast.service';
import { sameAlbum, type AcquisitionJobView } from '@nicotind/core';
import { IDLE_HUNT, SEARCHING_HUNT, type AlbumHuntStatus } from '../lib/album-hunt-status';
import type { DiscographyAlbum } from './api/api-types';
import { hasCommittedTotal, jobDenominator } from '../lib/download-groups';
import { classifyHuntDownloadError } from '../lib/hunt-download-outcome';
import { failureDigest, type GetFailure } from '../lib/failure-digest';

function jobStatus(job: AcquisitionJobView): AlbumHuntStatus {
  // A Get the server has reserved but not yet found a source for.
  if (job.stage === 'resolving' && job.kind !== 'url') return { phase: 'searching', jobId: job.id };
  return {
    phase: 'job',
    stage: job.stage,
    jobId: job.id,
    // A total the job has not committed to (a lazily-enumerated URL) is not one.
    ...(hasCommittedTotal(job)
      ? { delivered: job.progress.delivered, expected: jobDenominator(job.progress) }
      : {}),
  };
}

@Injectable({ providedIn: 'root' })
export class AutoHuntService {
  private api = inject(DownloadsApiService);
  private transfer = inject(TransferService);
  private toasts = inject(ToastService);
  private router = inject(Router);
  /** The failure toast on screen, so a run of failures groups into one (#1509). */
  private failureToast: { id: string; failures: GetFailure[] } | null = null;
  /** Gets this session asked for, by job id, until the feed says how each ended. */
  private readonly asked = new Map<string, { title: string; openManual: () => void }>();
  /**
   * Albums clicked whose job is not visible yet, refcounted: the auto-hunt and
   * the manual modal can hold the same album at once.
   */
  private readonly pending = signal<ReadonlyMap<number, number>>(new Map());

  /** The newest active job per Lidarr album; finished jobs never lock a card. */
  private readonly activeJobByAlbum = computed(() => {
    const byAlbum = new Map<number, AcquisitionJobView>();
    for (const job of this.transfer.acquisitionJobs()) {
      if (job.state !== 'active' || job.lidarrAlbumId === null) continue;
      const seen = byAlbum.get(job.lidarrAlbumId);
      if (!seen || job.createdAt > seen.createdAt) byAlbum.set(job.lidarrAlbumId, job);
    }
    return byAlbum;
  });

  /** Every live job, newest first — the pool `statusForAlbum` matches by name. */
  private readonly activeJobs = computed(() =>
    this.transfer
      .acquisitionJobs()
      .filter((j) => j.state === 'active')
      .sort((a, b) => b.createdAt - a.createdAt),
  );

  constructor() {
    // The server owns a Get from the click on, so its failure arrives on the feed.
    effect(() => this.settleAsked(this.transfer.acquisitionJobs()));
  }

  statusFor(lidarrId: number): AlbumHuntStatus {
    if (this.pending().has(lidarrId)) return SEARCHING_HUNT;
    const job = this.activeJobByAlbum().get(lidarrId);
    return job ? jobStatus(job) : IDLE_HUNT;
  }

  /**
   * The album's status whichever lane is fetching it (#1539): its Lidarr id when
   * the surface has one, else — or also — any live job naming the same album
   * (`sameAlbum`, the server guard's own rule). So a catalog card shows the peer
   * folder grab of its album, a folder shows the catalog Get of its album, and
   * all of it survives a reload, since it is read off the job feed.
   */
  statusForAlbum(target: {
    artist?: string | null;
    title?: string | null;
    lidarrAlbumId?: number | null;
  }): AlbumHuntStatus {
    const id = target.lidarrAlbumId ?? null;
    if (id !== null) {
      const byId = this.statusFor(id);
      if (byId.phase !== 'idle') return byId;
    }
    if (!target.artist || !target.title) return IDLE_HUNT;
    const named = { artist: target.artist, title: target.title };
    const job = this.activeJobs().find(
      (j) =>
        j.artistName !== null &&
        j.albumTitle !== null &&
        sameAlbum(named, { artist: j.artistName, title: j.albumTitle }),
    );
    return job ? jobStatus(job) : IDLE_HUNT;
  }

  /** Hold an album as `searching` until the matching `endSearch`. */
  beginSearch(lidarrId: number): void {
    this.pending.update((m) => new Map(m).set(lidarrId, (m.get(lidarrId) ?? 0) + 1));
  }

  endSearch(lidarrId: number): void {
    this.pending.update((m) => {
      const next = new Map(m);
      const count = (next.get(lidarrId) ?? 0) - 1;
      if (count > 0) next.set(lidarrId, count);
      else next.delete(lidarrId);
      return next;
    });
  }

  reset(): void {
    this.pending.set(new Map());
    this.asked.clear();
    this.failureToast = null;
  }

  /**
   * Ask the server for the album. It finds, picks and enqueues on its own (and
   * keeps going with this tab closed), so success says nothing here: the card
   * shows the job. `openManual` is offered when the Get fails.
   */
  hunt(album: DiscographyAlbum, artistName: string, openManual: () => void): void {
    if (this.statusFor(album.lidarrId).phase !== 'idle') return;
    this.beginSearch(album.lidarrId);
    void this.request(album, artistName, openManual).finally(() => this.endSearch(album.lidarrId));
  }

  private async request(
    album: DiscographyAlbum,
    artistName: string,
    openManual: () => void,
  ): Promise<void> {
    try {
      const { jobId } = await firstValueFrom(
        this.api.getAlbum(album.lidarrId, {
          artistName,
          albumTitle: album.title,
          localAlbumId: album.localAlbumId,
        }),
      );
      this.asked.set(jobId, { title: album.title, openManual });
      // Awaited so the hold is released only once the job is in the feed — the
      // card goes searching → job with no idle gap.
      await this.transfer.kickPoll();
    } catch (err) {
      const outcome = classifyHuntDownloadError(err);
      if (outcome.kind === 'already-complete') {
        this.toasts.show({ message: `You already have "${album.title}"`, kind: 'info' });
      } else if (outcome.kind === 'already-downloading') {
        let id!: string;
        id = this.toasts.show({
          message: `"${album.title}" is already downloading`,
          kind: 'info',
          actions: [this.viewInDownloads(() => id)],
        });
      } else {
        this.showFailure({ title: album.title, reason: outcome.message }, openManual);
      }
    }
  }

  /** Cancel a Get or its download from the surface that started it. */
  async cancel(jobId: string): Promise<void> {
    this.asked.delete(jobId);
    try {
      await firstValueFrom(this.api.cancelJob(jobId));
    } catch {
      this.toasts.show({ message: "Couldn't cancel — try from Downloads", kind: 'error' });
    }
    await this.transfer.kickPoll();
  }

  /** Toast each asked-for Get the feed now shows as failed; forget the ones that moved on. */
  private settleAsked(jobs: readonly AcquisitionJobView[]): void {
    if (this.asked.size === 0) return;
    for (const job of jobs) {
      const ask = this.asked.get(job.id);
      if (!ask) continue;
      if (job.state === 'active' && job.stage === 'resolving') continue;
      this.asked.delete(job.id);
      // A cancel is the person's own doing, not news.
      if (job.state === 'failed' && !job.cancelRequested) {
        this.showFailure({ title: ask.title, reason: job.error ?? '' }, ask.openManual);
      }
    }
  }

  private viewInDownloads(toastId: () => string): ToastAction {
    return {
      label: 'View in Downloads',
      callback: () => {
        this.toasts.dismiss(toastId());
        void this.router.navigateByUrl('/get?tab=activity');
      },
    };
  }

  /**
   * The one toast for failed Gets. A failure while an earlier one is still on
   * screen folds into it, so a burst never pushes everything else off the capped
   * stack. A single album offers the manual picker; a group has no one album to
   * pick for, and points at Downloads, where each card carries its reason.
   */
  private showFailure(failure: GetFailure, openManual: () => void): void {
    const prior = this.failureToast;
    const onScreen = prior && this.toasts.toasts().some((t) => t.id === prior.id);
    const failures = [
      ...(onScreen ? prior.failures.filter((f) => f.title !== failure.title) : []),
      failure,
    ];
    if (onScreen) this.toasts.dismiss(prior.id);

    let id!: string;
    const dismiss: ToastAction = { label: 'Dismiss', callback: () => this.toasts.dismiss(id) };
    const next: ToastAction =
      failures.length > 1
        ? this.viewInDownloads(() => id)
        : {
            label: 'Find Manually',
            callback: () => {
              this.toasts.dismiss(id);
              openManual();
            },
          };
    id = this.toasts.show({
      message: failureDigest(failures),
      kind: 'error',
      actions: [dismiss, next],
    });
    this.failureToast = { id, failures };
  }
}
