import { Injectable, computed, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom, of, switchMap, map } from 'rxjs';
import { DownloadsApiService, HuntFailedError } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService, type ToastAction } from './toast.service';
import { sameAlbum, type AcquisitionJobView } from '@nicotind/core';
import {
  IDLE_HUNT,
  SEARCHING_HUNT,
  STARTING_HUNT,
  type AlbumHuntStatus,
} from '../lib/album-hunt-status';
import { huntCutShort, type DiscographyAlbum, type FolderCandidate } from './api/api-types';
import { mergeCandidates } from '../lib/merge-candidates';
import { hasCommittedTotal, jobDenominator } from '../lib/download-groups';
import {
  classifyHuntDownloadResult,
  classifyHuntDownloadError,
} from '../lib/hunt-download-outcome';

const AUTO_THRESHOLD = 60;
const COUNTDOWN_SECONDS = 3;
// Bounded self-heal (issue #530): on a retriable enqueue failure (peer offline,
// 5xx) advance to the next confident candidate — but never more than 3 total
// attempts, so a systemic failure (addon down) fails fast with its real reason
// instead of burning through the whole candidate list.
const MAX_DOWNLOAD_ATTEMPTS = 3;

function jobStatus(job: AcquisitionJobView): AlbumHuntStatus {
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
  private failureToast: { id: string; titles: string[] } | null = null;
  /**
   * Albums clicked whose job is not visible yet, refcounted: the auto-hunt and
   * the manual modal can hold the same album at once.
   */
  private readonly pending = signal<ReadonlyMap<number, number>>(new Map());
  /** Held albums whose pick is being enqueued: past "Finding…", no job yet. */
  private readonly starting = signal<ReadonlySet<number>>(new Set());
  /** Held albums still waiting their turn on the server: hunts ahead of each (#1625). */
  private readonly queuedAhead = signal<ReadonlyMap<number, number>>(new Map());

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

  statusFor(lidarrId: number): AlbumHuntStatus {
    if (this.pending().has(lidarrId)) {
      if (this.starting().has(lidarrId)) return STARTING_HUNT;
      const ahead = this.queuedAhead().get(lidarrId);
      return ahead ? { phase: 'searching', ahead } : SEARCHING_HUNT;
    }
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
    this.starting.set(new Set());
    this.queuedAhead.set(new Map());
  }

  private setQueuedAhead(lidarrId: number, ahead: number): void {
    this.queuedAhead.update((m) => {
      if ((m.get(lidarrId) ?? 0) === ahead) return m;
      const next = new Map(m);
      if (ahead > 0) next.set(lidarrId, ahead);
      else next.delete(lidarrId);
      return next;
    });
  }

  private setStarting(lidarrId: number, on: boolean): void {
    this.starting.update((s) => {
      const next = new Set(s);
      if (on) next.add(lidarrId);
      else next.delete(lidarrId);
      return next;
    });
  }

  hunt(album: DiscographyAlbum, artistName: string, openManual: () => void): void {
    if (this.statusFor(album.lidarrId).phase !== 'idle') return;
    this.beginSearch(album.lidarrId);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.setStarting(album.lidarrId, false);
      this.setQueuedAhead(album.lidarrId, 0);
      this.endSearch(album.lidarrId);
    };
    // The hold outlives _run(): a confident match hands off to a countdown toast,
    // and the card must stay busy until that settles and the job is visible.
    this._run(album, artistName, openManual, release).then((handedOff) => {
      if (!handedOff) release();
    }, release);
  }

  /** Resolves true when the hunt handed off to the countdown, which then owns `release`. */
  private async _run(
    album: DiscographyAlbum,
    artistName: string,
    openManual: () => void,
    release: () => void,
  ): Promise<boolean> {
    let candidates: FolderCandidate[] = [];
    // Why an empty result was empty (#1040/#1049): the source never reached its
    // network, or its search lanes were busy and this hunt was cut short. Either
    // way "no confident match" would be a claim about the album we cannot make.
    let sourceOffline = false;
    let sourceBusy = false;
    let answered = 0;
    let fired = 0;

    try {
      // Chain base + optional skew into one observable so both phases resolve
      // in a single async tick (two sequential firstValueFrom awaits would need
      // two microtask ticks, breaking tests that only flush one tick).
      const hunt = await firstValueFrom(
        this.api
          .huntAlbumBase(
            album.lidarrId,
            {
              artistName,
              albumTitle: album.title,
              skewSearch: true,
              localAlbumId: album.localAlbumId,
            },
            (wait) =>
              this.setQueuedAhead(album.lidarrId, wait.state === 'queued' ? wait.position : 0),
          )
          .pipe(
            switchMap((baseResult) => {
              if (baseResult.skewNeeded) {
                return this.api
                  .huntAlbumSkew(album.lidarrId, { artistName, albumTitle: album.title })
                  .pipe(
                    map((skewResult) => ({
                      candidates: mergeCandidates(baseResult.candidates, skewResult.candidates),
                      phases: [baseResult, skewResult],
                    })),
                  );
              }
              return of({ candidates: baseResult.candidates, phases: [baseResult] });
            }),
          ),
      );
      candidates = hunt.candidates;
      for (const phase of hunt.phases) {
        sourceOffline ||= phase.sourceOffline === true;
        sourceBusy ||= phase.rateLimited === true || huntCutShort(phase);
        fired += phase.searchesFired ?? 0;
        answered += phase.searchesAnswered ?? 0;
      }
    } catch (err) {
      this.setQueuedAhead(album.lidarrId, 0);
      // A queued hunt that ran and failed says why (#1625); anything else is a
      // transport failure with nothing more useful to add.
      const why = err instanceof HuntFailedError ? ` — ${err.message}` : '';
      let searchErrId!: string;
      searchErrId = this.toasts.show({
        message: `Search failed for "${album.title}"${why}`,
        kind: 'error',
        actions: [
          {
            label: 'Dismiss',
            callback: () => {
              this.toasts.dismiss(searchErrId);
            },
          },
          {
            label: 'Find Manually',
            callback: () => {
              this.toasts.dismiss(searchErrId);
              openManual();
            },
          },
        ],
      });
      return false;
    }

    // On a partly-owned album a folder with none of the missing tracks cannot
    // help, whatever its whole-album match (#1823) — the rule `acquireAlbum` picks by.
    const lacking = candidates.filter((c) => c.wantedMatched === 0);
    candidates = candidates.filter((c) => c.wantedMatched !== 0);
    const confident = candidates[0] !== undefined && candidates[0].matchPct >= AUTO_THRESHOLD;

    // No retry button: the source reconnects on its own over minutes, and a
    // button that fails until then only teaches people to mash it (#1040).
    if (!confident && sourceOffline) {
      let offlineId!: string;
      offlineId = this.toasts.show({
        message: `The download source is offline (reconnecting) — "${album.title}" was never searched. Try again in a few minutes.`,
        kind: 'error',
        actions: [
          {
            label: 'Dismiss',
            callback: () => {
              this.toasts.dismiss(offlineId);
            },
          },
        ],
      });
      return false;
    }

    // The source's search lanes were busy, so this hunt was cut short (#1049).
    // It is retriable right away — the lanes free within a hunt's length.
    if (!confident && sourceBusy) {
      const detail = fired > 0 ? ` — only ${answered} of ${fired} searches completed` : '';
      let busyId!: string;
      busyId = this.toasts.show({
        message: `The download source was busy${detail}; "${album.title}" may still be out there.`,
        kind: 'error',
        actions: [
          {
            label: 'Retry',
            callback: () => {
              this.toasts.dismiss(busyId);
              this.hunt(album, artistName, openManual);
            },
          },
          {
            label: 'Find Manually',
            callback: () => {
              this.toasts.dismiss(busyId);
              openManual();
            },
          },
        ],
      });
      return false;
    }

    const best = candidates[0];
    if (!best || best.matchPct < AUTO_THRESHOLD) {
      const onlyLacking = lacking.some((c) => c.matchPct >= AUTO_THRESHOLD);
      let noMatchId!: string;
      noMatchId = this.toasts.show({
        message: onlyLacking
          ? `No match has the tracks still missing from "${album.title}"`
          : `No confident match found for "${album.title}"`,
        kind: 'error',
        actions: [
          {
            label: 'Dismiss',
            callback: () => {
              this.toasts.dismiss(noMatchId);
            },
          },
          {
            label: 'Find Manually',
            callback: () => {
              this.toasts.dismiss(noMatchId);
              openManual();
            },
          },
        ],
      });
      return false;
    }

    // The countdown is where the pick is decided, so it names the pick (#1543).
    const pick = `${best.format} · ${best.matchedTracks}/${best.totalTracks} tracks from ${best.username}`;
    let toastId!: string;
    toastId = this.toasts.show({
      message: `Best match: ${pick} — downloading "${album.title}" in ${COUNTDOWN_SECONDS}s`,
      kind: 'info',
      countdown: COUNTDOWN_SECONDS,
      actions: [
        {
          label: 'Download Now',
          callback: () => {
            void this._download(toastId, album, candidates, openManual).finally(release);
          },
        },
        {
          label: 'Cancel',
          callback: () => {
            this.toasts.dismiss(toastId);
            release();
          },
        },
        {
          label: 'Choose Manually',
          callback: () => {
            this.toasts.dismiss(toastId);
            release();
            openManual();
          },
        },
      ],
    });
    // At the toast cap a countdown is dropped unseen and never fires, so nothing
    // would ever release this album — hand the user the manual picker instead.
    if (!this.toasts.toasts().some((t) => t.id === toastId)) {
      openManual();
      return false;
    }
    return true;
  }

  private async _download(
    countdownToastId: string,
    album: DiscographyAlbum,
    candidates: FolderCandidate[],
    openManual: () => void,
  ): Promise<void> {
    this.toasts.dismiss(countdownToastId);
    this.setStarting(album.lidarrId, true);

    const toFiles = (c: FolderCandidate) =>
      c.files.map((f) => ({ filename: f.filename, size: f.size }));
    // Only confident candidates are worth an unattended attempt; the addon's
    // own cross-peer fallback covers post-enqueue stalls, this loop covers
    // enqueue-time failures.
    const attempts = candidates
      .filter((c) => c.matchPct >= AUTO_THRESHOLD)
      .slice(0, MAX_DOWNLOAD_ATTEMPTS);

    for (let i = 0; i < attempts.length; i++) {
      const pick = attempts[i];
      try {
        const res = await firstValueFrom(
          this.api.huntDownload(
            album.lidarrId,
            {
              selected: {
                username: pick.username,
                directory: pick.directory,
                files: toFiles(pick),
                candidateRef: pick.candidateRef,
              },
              alternates: candidates
                .filter((c) => c !== pick)
                .map((c) => ({
                  username: c.username,
                  directory: c.directory,
                  files: toFiles(c),
                })),
              localAlbumId: album.localAlbumId,
            },
            false,
          ),
        );

        if (classifyHuntDownloadResult(res) === 'already-complete') {
          this.toasts.show({
            message: `You already have "${album.title}"`,
            kind: 'info',
          });
          return;
        }

        this.toasts.show({
          message: `Downloading "${album.title}"`,
          kind: 'success',
        });
        // Awaited so the caller's release lands after the job is in
        // acquisitionJobs — the card goes searching → job with no idle gap.
        await this.transfer.kickPoll();
        return;
      } catch (err) {
        const outcome = classifyHuntDownloadError(err);
        if (outcome.kind === 'already-complete') {
          this.toasts.show({ message: `You already have "${album.title}"`, kind: 'info' });
          return;
        }
        if (outcome.kind === 'already-downloading') {
          let queuedId!: string;
          queuedId = this.toasts.show({
            message: `"${album.title}" is already downloading`,
            kind: 'info',
            actions: [this.viewInDownloads(() => queuedId)],
          });
          return;
        }
        const next = attempts[i + 1];
        if (outcome.retriable && next) {
          this.toasts.show({
            message: `"${pick.username}" unavailable — trying "${next.username}"…`,
            kind: 'info',
          });
          continue;
        }
        this.showDownloadFailure(album, outcome.message, openManual);
        return;
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
   * The last word on a failed Get. A failure while an earlier one is still on
   * screen folds into it, or a burst of album clicks pushes everything else off the
   * capped stack. A group offers no Find Manually: there is no one album to find.
   * Nor does an album that a job is already fetching (#1509).
   */
  private showDownloadFailure(
    album: DiscographyAlbum,
    reason: string,
    openManual: () => void,
  ): void {
    const prior = this.failureToast;
    const onScreen = prior && this.toasts.toasts().some((t) => t.id === prior.id);
    const titles = [...new Set([...(onScreen ? prior.titles : []), album.title])];
    if (onScreen) this.toasts.dismiss(prior.id);

    let id!: string;
    const dismiss: ToastAction = { label: 'Dismiss', callback: () => this.toasts.dismiss(id) };
    if (titles.length > 1) {
      const named = titles.map((t) => `"${t}"`).join(', ');
      id = this.toasts.show({
        message: `${titles.length} albums failed: ${named}`,
        kind: 'error',
        actions: [dismiss],
      });
    } else {
      const next: ToastAction = this.activeJobByAlbum().has(album.lidarrId)
        ? this.viewInDownloads(() => id)
        : {
            label: 'Find Manually',
            callback: () => {
              this.toasts.dismiss(id);
              openManual();
            },
          };
      id = this.toasts.show({
        message: reason
          ? `Download failed for "${album.title}" — ${reason}`
          : `Download failed for "${album.title}"`,
        kind: 'error',
        actions: [dismiss, next],
      });
    }
    this.failureToast = { id, titles };
  }
}
