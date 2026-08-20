import { Component, OnDestroy, computed, inject, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { CoverArtComponent } from '../cover-art/cover-art.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { DownloadReviewService } from '../../services/download-review.service';
import { ReviewApiService } from '../../services/api/review-api.service';
import { AuthService } from '../../services/auth.service';
import { ConfirmService } from '../../services/confirm.service';
import { ToastService } from '../../services/toast.service';
import { TranslateService } from '../../services/translate.service';
import { TransferService } from '../../services/transfer.service';
import { PlayerService } from '../../services/player.service';
import { LibraryApiService } from '../../services/api/library-api.service';
import { toTrack } from '../../lib/track-utils';
import type {
  QuarantineSong,
  ReviewQueueAlbum,
  SongSteps,
  StepState,
} from '../../services/api/api-types';

/** Ordered step badges rendered per album, mirroring the Admin quarantine queue's `stepKeys`. */
export const STEP_KEYS = [
  'bpm',
  'key',
  'energy',
  'genre',
  'mood',
] as const satisfies (keyof SongSteps)[];

export type StepKey = (typeof STEP_KEYS)[number];

/**
 * Aggregate one album's per-song step states into one badge per step
 * (5 total, not 5 × song count). Per step, the *worst* state across the
 * album's songs wins: any `pending` outranks `skipped`, which outranks
 * `done` — so a single still-queued track keeps the whole album's badge
 * showing "in progress" rather than a false "done", and a step that failed
 * everywhere it wasn't still pending shows as `skipped`. Pure + exported so
 * it's unit-testable without rendering the component.
 */
export function aggregateAlbumSteps(songs: QuarantineSong[]): Record<StepKey, StepState> {
  const result = {} as Record<StepKey, StepState>;
  for (const step of STEP_KEYS) {
    const states = songs.map((song) => song.steps[step]);
    if (states.some((s) => s === 'pending')) result[step] = 'pending';
    else if (states.some((s) => s === 'skipped')) result[step] = 'skipped';
    else result[step] = 'done';
  }
  return result;
}

/**
 * Download inbox triage (issue #411): a "Needs review" section on the
 * Downloads page for albums that finished quarantine's required steps but
 * are held for a curator's approve/discard/fix decision. Self-gating —
 * renders nothing for a non-curator or an empty queue — so the Downloads
 * page can mount it unconditionally.
 */
@Component({
  selector: 'app-review-inbox',
  imports: [CoverArtComponent, TranslatePipe],
  templateUrl: './review-inbox.component.html',
})
export class ReviewInboxComponent implements OnDestroy {
  private review = inject(DownloadReviewService);
  private api = inject(ReviewApiService);
  private auth = inject(AuthService);
  private confirm = inject(ConfirmService);
  private toast = inject(ToastService);
  private i18n = inject(TranslateService);
  private transfers = inject(TransferService);
  private player = inject(PlayerService);
  private library = inject(LibraryApiService);

  readonly stepKeys = STEP_KEYS;

  /** Emitted when a curator wants to fix a track's metadata before approving (Task 12 opens the modal). */
  readonly fixRequested = output<ReviewQueueAlbum>();

  readonly queue = this.review.queue;
  readonly visible = computed(() => this.auth.canCurate() && this.queue().length > 0);

  /** True while a bulk approve/discard sweep is in flight — disables both bulk buttons. */
  readonly bulkBusy = signal(false);

  private stopStart: () => void;
  private stopWatch: () => void;

  constructor() {
    // Owns exactly one start()/watchQueue() pair per instance — each dispose
    // closure is called exactly once, in ngOnDestroy (neither is
    // double-dispose-safe).
    this.stopStart = this.review.start();
    this.stopWatch = this.review.watchQueue();
  }

  ngOnDestroy(): void {
    this.stopStart();
    this.stopWatch();
  }

  coverUrl(album: ReviewQueueAlbum): string {
    return `/api/cover/${album.albumId}?size=300&token=${this.auth.token()}`;
  }

  /** One aggregated `{bpm,key,energy,genre,mood}` state per album — see `aggregateAlbumSteps`. */
  stepsFor(album: ReviewQueueAlbum): Record<StepKey, StepState> {
    return aggregateAlbumSteps(album.songs);
  }

  async listen(album: ReviewQueueAlbum): Promise<void> {
    const first = album.songs[0];
    if (!first) return;
    try {
      const song = await firstValueFrom(this.library.getSong(first.id));
      this.player.playSingle(toTrack(song, album.albumTitle));
    } catch {
      // Best-effort — a failed lookup just doesn't start playback.
    }
  }

  fix(album: ReviewQueueAlbum): void {
    this.fixRequested.emit(album);
  }

  async approve(album: ReviewQueueAlbum): Promise<void> {
    try {
      await firstValueFrom(this.api.approve(album.albumId));
      await this.review.refresh();
      this.transfers.markLibraryDirty();
      this.toast.show({ message: this.i18n.t('review.approved'), kind: 'success' });
    } catch {
      // Leave the album in the queue; the curator can retry.
    }
  }

  async discard(album: ReviewQueueAlbum): Promise<void> {
    const ok = await this.confirm.ask(
      this.i18n.t('review.confirmDiscard', { album: album.albumTitle }),
    );
    if (!ok) return;
    try {
      await firstValueFrom(this.api.discard(album.albumId));
      await this.review.refresh();
      this.transfers.markLibraryDirty();
      this.toast.show({ message: this.i18n.t('review.discarded'), kind: 'success' });
    } catch {
      // Leave the album in the queue; the curator can retry.
    }
  }

  /** Approve every album currently queued (issue #592). */
  approveAll(): Promise<void> {
    return this.runBulk('approve');
  }

  /** Discard every album currently queued — deletes their files (issue #592). */
  discardAll(): Promise<void> {
    return this.runBulk('discard');
  }

  /**
   * Shared bulk sweep. Deliberately fans out over the *existing* per-album
   * endpoints rather than adding a bulk route: each one already records its own
   * audit entry, and per-album granularity is worth more for a destructive mass
   * action than the atomicity a single route would buy. Runs sequentially (a
   * queue of 34 shouldn't arrive as 34 simultaneous deletes) and never aborts on
   * a failure — the point of a bulk action is not having to retry the rest by
   * hand — so the outcome is reported as a count, partial or complete.
   */
  private async runBulk(action: 'approve' | 'discard'): Promise<void> {
    if (this.bulkBusy()) return;
    const albums = [...this.queue()];
    if (albums.length === 0) return;
    const confirmKey =
      action === 'approve' ? 'review.confirmApproveAll' : 'review.confirmDiscardAll';
    const ok = await this.confirm.ask(this.i18n.t(confirmKey, { count: albums.length }));
    if (!ok) return;

    this.bulkBusy.set(true);
    let failed = 0;
    try {
      for (const album of albums) {
        try {
          await firstValueFrom(
            action === 'approve'
              ? this.api.approve(album.albumId)
              : this.api.discard(album.albumId),
          );
        } catch {
          failed++;
        }
      }
      await this.review.refresh();
      this.transfers.markLibraryDirty();
      const done = albums.length - failed;
      this.toast.show(
        failed > 0
          ? { message: this.i18n.t('review.bulkPartial', { done, failed }), kind: 'error' }
          : { message: this.i18n.t('review.bulkDone', { count: done }), kind: 'success' },
      );
    } finally {
      this.bulkBusy.set(false);
    }
  }
}
