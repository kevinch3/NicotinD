import { Component, inject, signal } from '@angular/core';
import { FeedbackService } from '../../../services/feedback.service';
import { FeedbackSheetService } from '../../../services/feedback-sheet.service';
import type {
  GenerationFeedbackSummary,
  GenerationVerdict,
  HuntMatchOutput,
  HuntMatchInput,
} from '../../../../types/core';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { TvNavGroupDirective } from '../../../directives/tv-nav-group.directive';
import { TvNavItemDirective } from '../../../directives/tv-nav-item.directive';

/**
 * Admin review queue for generation-feedback captures. The durable half of the
 * grading loop: the capture toast is a fast path that only exists in the seconds
 * after a hunt, and issue #451 showed how easily a run of captures goes ungraded
 * when that is the only surface. Loads on demand (the group's `opened` output),
 * never on the ServiceReview poll — this is a dev list, not live status.
 * See docs/generation-feedback.md.
 */
@Component({
  selector: 'app-feedback-queue',
  standalone: true,
  imports: [TranslatePipe, TvNavGroupDirective, TvNavItemDirective],
  templateUrl: './feedback-queue.component.html',
})
export class FeedbackQueueComponent {
  private feedback = inject(FeedbackService);
  private sheet = inject(FeedbackSheetService);

  readonly rows = signal<GenerationFeedbackSummary[]>([]);
  readonly loading = signal(false);
  readonly loaded = signal(false);

  /** Fetch once per page visit — the group re-emits `opened` on every expand. */
  load(): void {
    if (this.loaded() || this.loading()) return;
    this.loading.set(true);
    this.feedback.listSummaries().subscribe({
      next: (rows) => {
        this.rows.set(rows);
        this.loaded.set(true);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  /** Force a re-fetch (after grading, or the explicit Refresh button). */
  reload(): void {
    this.loaded.set(false);
    this.load();
  }

  grade(row: GenerationFeedbackSummary, verdict: GenerationVerdict): void {
    this.feedback.resolve(row.id, verdict).subscribe();
    // Optimistic: the row stays put so the admin keeps their place in the list.
    this.rows.update((rs) => rs.map((r) => (r.id === row.id ? { ...r, verdict } : r)));
  }

  /**
   * 👎 needs the scored candidates to ask "which folder was actually right?" —
   * and those live in the snapshot the summary deliberately omits, so fetch the
   * one record now rather than making the whole list heavy.
   */
  openSheet(row: GenerationFeedbackSummary): void {
    this.feedback.getOne(row.id).subscribe((full) => {
      const output = full.output as HuntMatchOutput | null;
      const input = full.input as Partial<HuntMatchInput> | null;
      this.sheet.open({
        feedbackId: row.id,
        artistName: row.artistName ?? input?.artistName ?? '',
        albumTitle: row.albumTitle ?? input?.albumTitle ?? '',
        candidates: (output?.candidates ?? []).map((c) => ({
          username: c.username,
          directory: c.directory,
          matchPct: c.matchPct,
          format: c.format,
        })),
      });
    });
  }

  formatWhen(at: number): string {
    return new Date(at).toLocaleString();
  }
}
