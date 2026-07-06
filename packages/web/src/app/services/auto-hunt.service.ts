import { Injectable, inject, signal } from '@angular/core';
import { firstValueFrom, of, switchMap, map } from 'rxjs';
import { DownloadsApiService } from './api/downloads-api.service';
import { TransferService } from './transfer.service';
import { ToastService } from './toast.service';
import type { DiscographyAlbum, FolderCandidate } from './api/api-types';
import { mergeCandidates } from '../lib/merge-candidates';
import {
  classifyHuntDownloadResult,
  classifyHuntDownloadError,
} from '../lib/hunt-download-outcome';

const AUTO_THRESHOLD = 60;
const COUNTDOWN_SECONDS = 3;

@Injectable({ providedIn: 'root' })
export class AutoHuntService {
  private api = inject(DownloadsApiService);
  private transfer = inject(TransferService);
  private toasts = inject(ToastService);

  readonly huntingAlbumIds = signal<Set<number>>(new Set());

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

    try {
      // Chain base + optional skew into one observable so both phases resolve
      // in a single async tick (two sequential firstValueFrom awaits would need
      // two microtask ticks, breaking tests that only flush one tick).
      candidates = await firstValueFrom(
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
                    map((skewResult) =>
                      mergeCandidates(baseResult.candidates, skewResult.candidates),
                    ),
                  );
              }
              return of(baseResult.candidates);
            }),
          ),
      );
    } catch {
      let searchErrId!: string;
      searchErrId = this.toasts.show({
        message: `Search failed for "${album.title}"`,
        kind: 'error',
        actions: [
          { label: 'Dismiss', callback: () => { this.toasts.dismiss(searchErrId); } },
          { label: 'Find Manually', callback: () => { this.toasts.dismiss(searchErrId); openManual(); } },
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
          { label: 'Dismiss', callback: () => { this.toasts.dismiss(noMatchId); } },
          { label: 'Find Manually', callback: () => { this.toasts.dismiss(noMatchId); openManual(); } },
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
          callback: () => { void this._download(toastId, album, candidates, openManual); },
        },
        {
          label: 'Cancel',
          callback: () => { this.toasts.dismiss(toastId); },
        },
        {
          label: 'Choose Manually',
          callback: () => { this.toasts.dismiss(toastId); openManual(); },
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

    const [best, ...rest] = candidates;
    const toFiles = (c: FolderCandidate) => c.files.map((f) => ({ filename: f.filename, size: f.size }));

    try {
      const res = await firstValueFrom(
        this.api.huntDownload(
          album.lidarrId,
          {
            selected: {
              username: best.username,
              directory: best.directory,
              files: toFiles(best),
            },
            alternates: rest.map((c) => ({
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
    } catch (err) {
      const outcome = classifyHuntDownloadError(err);
      if (outcome.kind === 'already-complete') {
        this.toasts.show({ message: `You already have "${album.title}"`, kind: 'info' });
      } else if (outcome.kind === 'already-downloading') {
        this.toasts.show({ message: `"${album.title}" is already downloading`, kind: 'info' });
      } else {
        let dlErrId!: string;
        dlErrId = this.toasts.show({
          message: `Download failed for "${album.title}"`,
          kind: 'error',
          actions: [
            { label: 'Dismiss', callback: () => { this.toasts.dismiss(dlErrId); } },
            { label: 'Find Manually', callback: () => { this.toasts.dismiss(dlErrId); openManual(); } },
          ],
        });
      }
    }
  }
}
