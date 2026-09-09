import { Component, computed, inject, input, output, signal } from '@angular/core';
import { registerOverlayCloser } from '../../services/native/back-button.service';
import { BottomChromeSafeDirective } from '../../directives/bottom-chrome-safe.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import type { AlternateSource } from '../../services/api/api-types';

/**
 * Pick a peer to take over the tracks a download is stuck on (#1065).
 *
 * The dialog exists *because* the search is slow. Core keeps no candidates
 * after a job starts — `candidateRef` is addon-side and short-lived — so
 * finding another peer means re-running the hunt, tens of seconds of it. A
 * one-click action would be a button that hangs and then reports a decision
 * the user never saw; this states what it is doing and shows the evidence the
 * choice was made on.
 *
 * → docs/download-pipeline.md "Re-sourcing from another peer"
 */
@Component({
  selector: 'app-resource-picker',
  standalone: true,
  imports: [BottomChromeSafeDirective, TranslatePipe],
  templateUrl: './resource-picker.component.html',
})
export class ResourcePickerComponent {
  private api = inject(DownloadsApiService);

  readonly jobId = input.required<string>();
  /** Titles the user ticked; empty means every still-pending track. */
  readonly titles = input<string[]>([]);

  readonly cancel = output<void>();
  /** Emitted once the re-source is accepted, so the feed can re-poll. */
  readonly resourced = output<{ peer: string; count: number }>();

  readonly searching = signal(true);
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly wanted = signal<string[]>([]);
  readonly alternates = signal<AlternateSource[]>([]);
  readonly rateLimited = signal(false);
  readonly sourceOffline = signal(false);
  /** `candidateRef` of the chosen peer — the top row, until the user says otherwise. */
  readonly chosen = signal<string | null>(null);

  readonly selected = computed(() =>
    this.alternates().find((a) => a.candidateRef === this.chosen()),
  );

  constructor() {
    registerOverlayCloser(() => this.cancel.emit());
    // `input.required` is readable here because the overlay is only created
    // once its inputs are bound (the parent gates it behind an @if).
    queueMicrotask(() => this.search());
  }

  private search(): void {
    this.searching.set(true);
    this.error.set(null);
    this.api.searchAlternateSources(this.jobId(), this.titles()).subscribe({
      next: (res) => {
        this.wanted.set(res.wanted);
        this.alternates.set(res.alternates);
        this.rateLimited.set(!!res.rateLimited);
        this.sourceOffline.set(!!res.sourceOffline);
        // Preselect the best row: the ranking already answers "which peer",
        // and making the user re-derive it is friction with no information.
        this.chosen.set(res.alternates[0]?.candidateRef ?? null);
        this.searching.set(false);
      },
      error: () => {
        this.searching.set(false);
        this.error.set('downloads.resource.failed');
      },
    });
  }

  choose(ref: string): void {
    this.chosen.set(ref);
  }

  submit(): void {
    const pick = this.selected();
    if (!pick || this.submitting()) return;
    this.submitting.set(true);
    // Ask for what THIS peer actually has, not for everything that was
    // pending: a peer covering 9 of 14 should be given the 9, and the rest
    // left with their current source rather than handed to someone who cannot
    // deliver them.
    this.api.resourceJob(this.jobId(), pick.candidateRef, pick.coveredTitles).subscribe({
      next: (res) => {
        this.submitting.set(false);
        this.resourced.emit({ peer: pick.username, count: res.resourced });
      },
      error: () => {
        this.submitting.set(false);
        this.error.set('downloads.resource.failed');
      },
    });
  }
}
