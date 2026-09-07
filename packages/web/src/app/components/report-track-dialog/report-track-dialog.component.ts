import { Component, inject, input, output, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TRACK_REPORT_REASONS, isTasteOnly, type TrackReportReason } from '@nicotind/core';
import { LibraryApiService } from '../../services/api/library-api.service';
import { RecommendationsApiService } from '../../services/api/recommendations-api.service';
import { ToastService } from '../../services/toast.service';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * "Report this track" (issue #987).
 *
 * A single Report button produces a queue nobody can triage — "bad" is not an
 * actionable finding — so the reason is a closed set, each of which routes to a
 * specific kind of fix. The free-text note is optional on every one of them.
 *
 * `not_for_me` is routed away from curation entirely: nothing is wrong with the
 * track, the listener just does not want it, and the recommender already models
 * that. Sending it to the metadata worklist would fill the backlog with items
 * no curator could ever action.
 */
@Component({
  selector: 'app-report-track-dialog',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './report-track-dialog.component.html',
})
export class ReportTrackDialogComponent {
  private readonly library = inject(LibraryApiService);
  private readonly recommendations = inject(RecommendationsApiService);
  private readonly toast = inject(ToastService);

  readonly trackId = input.required<string>();
  readonly closed = output<void>();

  readonly REASONS = TRACK_REPORT_REASONS;
  readonly selected = signal<TrackReportReason | null>(null);
  readonly note = signal('');
  readonly busy = signal(false);

  select(reason: TrackReportReason): void {
    this.selected.set(reason);
  }

  onNote(value: string): void {
    this.note.set(value);
  }

  labelKey(reason: TrackReportReason): string {
    return `report.reason.${reason}`;
  }

  async submit(): Promise<void> {
    const reason = this.selected();
    if (!reason || this.busy()) return;
    this.busy.set(true);
    try {
      if (isTasteOnly(reason)) {
        // Straight to the taste signal — this never becomes a curation flag.
        await firstValueFrom(
          this.recommendations.feedback(this.trackId(), 'exclude', { via: 'report' }),
        );
        this.toast.show({ message: "Got it — we'll play it less", kind: 'success' });
      } else {
        const res = await firstValueFrom(
          this.library.reportTrack(this.trackId(), reason, this.note()),
        );
        this.toast.show({
          message:
            res.flagged && res.reportCount > 1
              ? `Thanks — ${res.reportCount} people have reported this`
              : 'Thanks — sent to the curation backlog',
          kind: 'success',
        });
      }
      this.closed.emit();
    } catch {
      this.toast.show({ message: "Couldn't send that report — try again", kind: 'error' });
    } finally {
      this.busy.set(false);
    }
  }
}
