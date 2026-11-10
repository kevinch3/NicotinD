import { Component, computed, inject, input, output, signal } from '@angular/core';
import { registerOverlayCloser } from '../../services/native/back-button.service';
import { BottomChromeSafeDirective } from '../../directives/bottom-chrome-safe.directive';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { DownloadsApiService } from '../../services/api/downloads-api.service';
import type { AlternateSource, AlternateSourcesResult } from '../../services/api/api-types';
import { OverflowRevealDirective } from '../../directives/overflow-reveal.directive';

/**
 * Pick a peer to take over the tracks a download is stuck on (#1065).
 *
 * Opened on request: a re-source picks the best peer by itself
 * (`ResourceService`), and this is where someone who wants another one chooses.
 * Core keeps no candidates after a job starts — `candidateRef` is addon-side
 * and short-lived — so a list that sat open too long is refused. The dialog
 * then searches again by itself and keeps the choice, rather than sending the
 * user back to the card.
 *
 * → docs/download-pipeline.md "Automatic by default, a picker on request"
 */
@Component({
  selector: 'app-resource-picker',
  standalone: true,
  imports: [OverflowRevealDirective, BottomChromeSafeDirective, TranslatePipe],
  templateUrl: './resource-picker.component.html',
})
export class ResourcePickerComponent {
  private api = inject(DownloadsApiService);

  readonly jobId = input.required<string>();
  /**
   * Titles the user ticked. A REQUIREMENT on the peers offered — "only show me
   * ones that have these" — never a narrowing of the request: re-sourcing
   * releases the stuck job, so whoever is chosen is asked for everything still
   * pending (#1069).
   */
  readonly require = input<string[]>([]);
  /** A search the caller already ran. Without one the dialog runs its own. */
  readonly seed = input<AlternateSourcesResult | null>(null);

  readonly cancel = output<void>();
  /** Emitted once the re-source is accepted, so the feed can re-poll. */
  readonly resourced = output<{ peer: string; count: number }>();

  readonly searching = signal(true);
  readonly submitting = signal(false);
  readonly error = signal<string | null>(null);
  readonly wanted = signal<string[]>([]);
  readonly required = signal<string[]>([]);
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
    queueMicrotask(() => {
      const seed = this.seed();
      if (seed) this.show(seed);
      else this.search();
    });
  }

  /** `keep` survives a refresh: tokens are re-minted per search, the peer's folder is not. */
  private search(keep?: AlternateSource, notice: string | null = null): void {
    this.searching.set(true);
    this.error.set(notice);
    this.api.searchAlternateSources(this.jobId(), this.require()).subscribe({
      next: (res) => this.show(res, keep),
      error: () => {
        this.searching.set(false);
        this.error.set('downloads.resource.failed');
      },
    });
  }

  private show(res: AlternateSourcesResult, keep?: AlternateSource): void {
    this.wanted.set(res.wanted);
    this.required.set(res.required ?? []);
    this.alternates.set(res.alternates);
    this.rateLimited.set(!!res.rateLimited);
    this.sourceOffline.set(!!res.sourceOffline);
    const kept =
      keep &&
      res.alternates.find((a) => a.username === keep.username && a.directory === keep.directory);
    // Preselect the best row: the ranking already answers "which peer",
    // and making the user re-derive it is friction with no information.
    this.chosen.set((kept ?? res.alternates[0])?.candidateRef ?? null);
    this.searching.set(false);
  }

  choose(ref: string): void {
    this.chosen.set(ref);
  }

  submit(): void {
    const pick = this.selected();
    if (!pick || this.submitting()) return;
    this.submitting.set(true);
    // What this peer actually has of everything still pending. Titles it does
    // not have stay on the released job and settle as `unavailable` — visible
    // on the card and re-sourceable again, rather than silently dropped.
    this.api.resourceJob(this.jobId(), pick.candidateRef, pick.coveredTitles).subscribe({
      next: (res) => {
        this.submitting.set(false);
        this.resourced.emit({ peer: pick.username, count: res.resourced });
      },
      error: (err: { status?: number }) => {
        this.submitting.set(false);
        // 409 is the source still holding the album, not a stale selection —
        // and only one of those is fixed by running the search again (#1069).
        if (err?.status === 409) return this.error.set('downloads.resource.conflict');
        // Anything else is a list this peer no longer honours, most often
        // because it sat open past the token's life. Fetch a new one here.
        this.search(pick, 'downloads.resource.refreshed');
      },
    });
  }
}
