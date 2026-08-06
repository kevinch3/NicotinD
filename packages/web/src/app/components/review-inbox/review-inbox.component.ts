import { Component, OnDestroy, computed, inject, output } from '@angular/core';
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
}
