import { Injectable, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import type {
  GenerationVerdict,
  HuntMatchItemFlags,
  GenerationFeedbackRecord,
  GenerationFeedbackSummary,
} from '../../types/core';
import { AuthService } from './auth.service';
import { ToastService } from './toast.service';
import { FeedbackSheetService, type FeedbackSheetCandidate } from './feedback-sheet.service';

/** Everything the capture toast needs to grade one hunt. */
export interface HuntFeedbackContext {
  feedbackId?: number;
  artistName: string;
  albumTitle: string;
  candidates: FeedbackSheetCandidate[];
}

const TOAST_SECONDS = 12;

/**
 * Client for the generation-feedback capture API. Owns the whole capture prompt:
 * the admin + dev-toggle gate, the one-per-hunt throttle, the 👍/👎 toast and the
 * 👎 detail sheet. Both hunt paths (AutoHuntService and AlbumHuntModalComponent)
 * call `promptForHunt` — issue #451 was one of them silently not prompting at all.
 * See docs/generation-feedback.md.
 */
@Injectable({ providedIn: 'root' })
export class FeedbackService {
  private http = inject(HttpClient);
  private auth = inject(AuthService);
  private toast = inject(ToastService);
  private sheet = inject(FeedbackSheetService);

  // Feedback ids already prompted this session — the base+skew merge, re-renders
  // and future radio replenish all re-surface the same id; only prompt once.
  private prompted = new Set<number>();

  /** The Admin review queue's list — summaries only, never the 251 KB snapshots. */
  listSummaries(graded?: boolean) {
    const qs = graded === undefined ? '' : `?graded=${graded}`;
    return this.http.get<GenerationFeedbackSummary[]>(`/api/feedback/summaries${qs}`);
  }

  /** One full capture — the queue needs its candidates to open the grading sheet. */
  getOne(id: number) {
    return this.http.get<GenerationFeedbackRecord>(`/api/feedback/${id}`);
  }

  resolve(
    id: number,
    verdict: GenerationVerdict,
    opts: { note?: string; itemFlags?: HuntMatchItemFlags } = {},
  ) {
    const body: { verdict: GenerationVerdict; note?: string; itemFlags?: HuntMatchItemFlags } = {
      verdict,
    };
    if (opts.note) body.note = opts.note;
    if (opts.itemFlags) body.itemFlags = opts.itemFlags;
    return this.http.patch<{ ok: boolean }>(`/api/feedback/${id}`, body);
  }

  /**
   * Admin dev-mode capture: when the server tagged this hunt with a pending
   * feedback id (admin + feedback-capture on), surface a one-tap grading toast.
   * 👍 = the recognizer's top pick was right; 👎 opens the detail sheet to mark
   * the actually-correct folder. A zero-candidate hunt is prompted too — "found
   * nothing" is the most valuable sample the recognizer can get.
   */
  promptForHunt(ctx: HuntFeedbackContext): void {
    if (!this.auth.isAdmin() || !this.auth.feedbackCapture()) return;
    if (!this.shouldPrompt(ctx.feedbackId)) return;
    const id = ctx.feedbackId as number;

    const toastId = this.toast.show({
      message: 'Did the hunt pick the right release?',
      kind: 'info',
      duration: TOAST_SECONDS,
      actions: [
        {
          label: '👍',
          callback: () => {
            this.resolve(id, 'good').subscribe();
            this.toast.dismiss(toastId);
          },
        },
        {
          label: '👎',
          callback: () => {
            this.sheet.open({
              feedbackId: id,
              artistName: ctx.artistName,
              albumTitle: ctx.albumTitle,
              candidates: ctx.candidates,
            });
            this.toast.dismiss(toastId);
          },
        },
      ],
    });

    // ToastService silently drops a new toast while 3 countdown toasts are live
    // (exactly what auto-hunt emits). Consuming the id before knowing the toast
    // rendered is why a dropped prompt was never re-offered — issue #451.
    if (!this.toast.toasts().some((t) => t.id === toastId)) return;
    this.markPrompted(id);
  }

  /** True while this feedbackId still deserves a prompt. Never mutates. */
  shouldPrompt(feedbackId: number | undefined | null): boolean {
    if (!feedbackId) return false;
    return !this.prompted.has(feedbackId);
  }

  /** Consume an id — call only once its prompt is actually on screen. */
  markPrompted(feedbackId: number): void {
    this.prompted.add(feedbackId);
  }
}
