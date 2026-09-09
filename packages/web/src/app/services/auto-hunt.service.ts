import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, of, switchMap, map } from 'rxjs';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService } from './toast.service';
import { huntCutShort, type DiscographyAlbum, type FolderCandidate } from './api/api-types';
import { mergeCandidates } from '../lib/merge-candidates';
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

@Injectable({ providedIn: 'root' })
export class AutoHuntService {
  private api = inject(DownloadsApiService);
  private transfer = inject(TransferService);
  private toasts = inject(ToastService);
  readonly huntingAlbumIds = signal<Set<number>>(new Set());
  /**
   * Any hunt in flight. The source runs one hunt session at a time (#1049), so
   * a second trigger would only queue behind the first; the triggers disable on
   * this instead of letting the user stack hunts that all wait.
   */
  readonly anyHunting = computed(() => this.huntingAlbumIds().size > 0);

  isHunting(lidarrId: number): boolean {
    return this.huntingAlbumIds().has(lidarrId);
  }

  reset(): void {
    this.huntingAlbumIds.set(new Set());
  }

  hunt(album: DiscographyAlbum, artistName: string, openManual: () => void): void {
    if (this.huntingAlbumIds().has(album.lidarrId)) return;
    this.huntingAlbumIds.update((s) => new Set(s).add(album.lidarrId));
    void this._run(album, artistName, openManual).finally(() => {
      this.huntingAlbumIds.update((s) => {
        const next = new Set(s);
        next.delete(album.lidarrId);
        return next;
      });
    });
  }

  private async _run(
    album: DiscographyAlbum,
    artistName: string,
    openManual: () => void,
  ): Promise<void> {
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
          .huntAlbumBase(album.lidarrId, {
            artistName,
            albumTitle: album.title,
            skewSearch: true,
          })
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
    } catch {
      let searchErrId!: string;
      searchErrId = this.toasts.show({
        message: `Search failed for "${album.title}"`,
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
      return;
    }

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
      return;
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
      return;
    }

    const best = candidates[0];
    if (!best || best.matchPct < AUTO_THRESHOLD) {
      let noMatchId!: string;
      noMatchId = this.toasts.show({
        message: `No confident match found for "${album.title}"`,
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
      return;
    }

    let toastId!: string;
    toastId = this.toasts.show({
      message: `Best match found — downloading "${album.title}" in ${COUNTDOWN_SECONDS}s`,
      kind: 'info',
      countdown: COUNTDOWN_SECONDS,
      actions: [
        {
          label: 'Download Now',
          callback: () => {
            void this._download(toastId, album, candidates, openManual);
          },
        },
        {
          label: 'Cancel',
          callback: () => {
            this.toasts.dismiss(toastId);
          },
        },
        {
          label: 'Choose Manually',
          callback: () => {
            this.toasts.dismiss(toastId);
            openManual();
          },
        },
      ],
    });
  }

  private async _download(
    countdownToastId: string,
    album: DiscographyAlbum,
    candidates: FolderCandidate[],
    openManual: () => void,
  ): Promise<void> {
    this.toasts.dismiss(countdownToastId);

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

        this.transfer.kickPoll();
        this.toasts.show({
          message: `Downloading "${album.title}"`,
          kind: 'success',
        });
        return;
      } catch (err) {
        const outcome = classifyHuntDownloadError(err);
        if (outcome.kind === 'already-complete') {
          this.toasts.show({ message: `You already have "${album.title}"`, kind: 'info' });
          return;
        }
        if (outcome.kind === 'already-downloading') {
          this.toasts.show({ message: `"${album.title}" is already downloading`, kind: 'info' });
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
        let dlErrId!: string;
        dlErrId = this.toasts.show({
          message: outcome.message
            ? `Download failed for "${album.title}" — ${outcome.message}`
            : `Download failed for "${album.title}"`,
          kind: 'error',
          actions: [
            {
              label: 'Dismiss',
              callback: () => {
                this.toasts.dismiss(dlErrId);
              },
            },
            {
              label: 'Find Manually',
              callback: () => {
                this.toasts.dismiss(dlErrId);
                openManual();
              },
            },
          ],
        });
        return;
      }
    }
  }
}
