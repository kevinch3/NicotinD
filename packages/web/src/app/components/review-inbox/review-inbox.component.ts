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
import { httpErrorMessage } from '../../lib/http-error';
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
  /** Albums with a single-item action in flight (#808) — per-row disabling +
   *  re-entrancy guard (double-clicking a card used to fire two POSTs). */
  readonly busyAlbums = signal(new Set<string>());

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

  /** Claim the per-row busy slot, or report the action is already covered. */
  private claimBusy(albumId: string): boolean {
    if (this.bulkBusy() || this.busyAlbums().has(albumId)) return false;
    this.busyAlbums.update((s) => new Set(s).add(albumId));
    return true;
  }

  private releaseBusy(albumId: string): void {
    this.busyAlbums.update((s) => {
      const next = new Set(s);
      next.delete(albumId);
      return next;
    });
  }

  /** Errors are surfaced, never swallowed (#808): a 404 means a concurrent
   *  decision already removed the album — drop the stale row; anything else
   *  toasts so the curator knows the click did not stick. */
  private surfaceActionError(err: unknown, albumId: string): void {
    if ((err as { status?: number }).status === 404) {
      this.review.dropFromQueue([albumId]);
      this.toast.show({ message: this.i18n.t('review.alreadyRemoved'), kind: 'error' });
      return;
    }
    this.toast.show({
      message: httpErrorMessage(err, this.i18n.t('review.actionFailed')),
      kind: 'error',
    });
  }

  async approve(album: ReviewQueueAlbum): Promise<void> {
    if (!this.claimBusy(album.albumId)) return;
    try {
      const res = await firstValueFrom(this.api.approve(album.albumId));
      this.review.dropFromQueue([album.albumId]);
      await this.review.forceRefresh();
      this.transfers.markLibraryDirty();
      // Only ever claim landed visibility the server actually confirmed
      // (issue #708) — a timed-out/still-processing approve still succeeds
      // as a decision, it just doesn't light up the Library banner yet.
      if (res.landed) this.transfers.noteAlbumsLanded([album.albumId]);
      this.toast.show({ message: this.i18n.t('review.approved'), kind: 'success' });
    } catch (err) {
      this.surfaceActionError(err, album.albumId);
    } finally {
      this.releaseBusy(album.albumId);
    }
  }

  async discard(album: ReviewQueueAlbum): Promise<void> {
    const ok = await this.confirm.ask(
      this.i18n.t('review.confirmDiscard', { album: album.albumTitle }),
    );
    if (!ok) return;
    if (!this.claimBusy(album.albumId)) return;
    try {
      await firstValueFrom(this.api.discard(album.albumId));
      this.review.dropFromQueue([album.albumId]);
      await this.review.forceRefresh();
      this.transfers.markLibraryDirty();
      this.toast.show({ message: this.i18n.t('review.discarded'), kind: 'success' });
    } catch (err) {
      this.surfaceActionError(err, album.albumId);
    } finally {
      this.releaseBusy(album.albumId);
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
   * Shared bulk sweep (#808): ONE server request per action. The old design
   * fanned out N per-album POSTs — written before #708 made each approve block
   * ~8 s on `landAlbumNow`, so a 54-album sweep took minutes, a mid-sweep
   * reload stranded the remainder, and the count never moved. The per-album
   * audit granularity the fan-out existed for is preserved server-side; the
   * explicit id snapshot means the count the curator confirmed is what gets
   * acted on. Bulk approve NEVER claims landed (#708's rule — the background
   * drain lands them within ≤60 s, #807), so `noteAlbumsLanded` is not called.
   */
  private async runBulk(action: 'approve' | 'discard'): Promise<void> {
    if (this.bulkBusy()) return;
    const ids = this.queue().map((a) => a.albumId);
    if (ids.length === 0) return;
    const confirmKey =
      action === 'approve' ? 'review.confirmApproveAll' : 'review.confirmDiscardAll';
    const ok = await this.confirm.ask(this.i18n.t(confirmKey, { count: ids.length }));
    if (!ok) return;

    this.bulkBusy.set(true);
    try {
      if (action === 'approve') {
        const res = await firstValueFrom(this.api.approveAll(ids));
        this.review.dropFromQueue([...res.approved, ...res.notFound]);
        this.transfers.markLibraryDirty();
        this.toast.show({
          message: this.i18n.t('review.bulkApproved', { count: res.approved.length }),
          kind: 'success',
        });
      } else {
        const res = await firstValueFrom(this.api.discardAll(ids));
        this.review.dropFromQueue([...res.discarded, ...res.notFound]);
        this.transfers.markLibraryDirty();
        this.toast.show(
          res.failed.length > 0
            ? {
                message: this.i18n.t('review.bulkPartial', {
                  done: res.discarded.length,
                  failed: res.failed.length,
                }),
                kind: 'error',
              }
            : {
                message: this.i18n.t('review.bulkDone', { count: res.discarded.length }),
                kind: 'success',
              },
        );
      }
      await this.review.forceRefresh();
    } catch (err) {
      // One failed request is one legible error — never a silently-swallowed
      // partial sweep.
      this.toast.show({
        message: httpErrorMessage(err, this.i18n.t('review.actionFailed')),
        kind: 'error',
      });
    } finally {
      this.bulkBusy.set(false);
    }
  }
}
