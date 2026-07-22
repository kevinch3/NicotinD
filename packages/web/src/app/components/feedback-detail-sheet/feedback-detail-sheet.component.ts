import { Component, inject, signal, computed } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  FeedbackSheetService,
  type FeedbackSheetCandidate,
} from '../../services/feedback-sheet.service';
import { FeedbackService } from '../../services/feedback.service';
import { ToastService } from '../../services/toast.service';
import type { HuntMatchItemFlags } from '../../../types/core';

/**
 * The 👎 detail sheet: after the capture toast's thumbs-down, the admin marks
 * which Soulseek folder was actually correct (or "none of these") + an optional
 * note. Resolves the pending feedback row as verdict=bad with the human truth,
 * which becomes the "expected correct folder" of a replay fixture.
 * See docs/generation-feedback.md.
 */
@Component({
  selector: 'app-feedback-detail-sheet',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './feedback-detail-sheet.component.html',
})
export class FeedbackDetailSheetComponent {
  private sheet = inject(FeedbackSheetService);
  private feedback = inject(FeedbackService);
  private toast = inject(ToastService);

  readonly payload = this.sheet.payload;
  // Selected correct folder: a candidate directory string, or 'none', or null (unset).
  readonly selected = signal<string | null>(null);
  readonly note = signal('');
  readonly submitting = signal(false);

  readonly canConfirm = computed(() => this.selected() !== null && !this.submitting());

  select(value: string): void {
    this.selected.set(value);
  }

  /** Build the itemFlags payload from the current selection. */
  buildItemFlags(): HuntMatchItemFlags {
    const sel = this.selected();
    const p = this.payload();
    if (sel === 'none' || sel === null || !p) return { correctFolder: null };
    const match = p.candidates.find((c) => c.directory === sel);
    return {
      correctFolder: match ? { username: match.username, directory: match.directory } : null,
    };
  }

  confirm(): void {
    const p = this.payload();
    if (!p || this.selected() === null) return;
    this.submitting.set(true);
    const note = this.note().trim();
    this.feedback
      .resolve(p.feedbackId, 'bad', {
        note: note || undefined,
        itemFlags: this.buildItemFlags(),
      })
      .subscribe({
        next: () => {
          this.toast.show({ message: 'Thanks — feedback recorded', kind: 'success' });
          this.reset();
        },
        error: () => {
          this.toast.show({ message: 'Could not save feedback', kind: 'error' });
          this.submitting.set(false);
        },
      });
  }

  cancel(): void {
    this.reset();
  }

  private reset(): void {
    this.selected.set(null);
    this.note.set('');
    this.submitting.set(false);
    this.sheet.close();
  }

  trackByDir = (_: number, c: FeedbackSheetCandidate) => c.directory;
}
