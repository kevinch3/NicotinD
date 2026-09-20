import { Component, computed, inject, signal } from '@angular/core';
import { CaseCardComponent } from './case-card.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { CurationApiService } from '../../services/api/curation-api.service';
import { ToastService } from '../../services/toast.service';
import { TranslateService } from '../../services/translate.service';
import type { CurationCase } from '../../services/api/api-types';

/**
 * One round of curation decisions (docs/curator-triage.md §3).
 *
 * A round is bounded on purpose: five cases, then a clear stopping point. An
 * unbounded queue is the thing curators stop opening.
 *
 * A failed apply leaves the case in place rather than advancing — silently
 * skipping past a decision that did not land is how a queue lies about its own
 * progress. A skip is recorded server-side, so the same card is not the first
 * thing shown in the next round.
 */
@Component({
  selector: 'app-curate',
  standalone: true,
  imports: [CaseCardComponent, TranslatePipe],
  templateUrl: './curate.component.html',
})
export default class CurateComponent {
  private readonly api = inject(CurationApiService);
  private readonly toast = inject(ToastService);
  private readonly i18n = inject(TranslateService);

  readonly cases = signal<CurationCase[]>([]);
  readonly index = signal(0);
  readonly busy = signal(false);
  /** Open flags the agent still has to turn into cards — shown so an empty
   *  round does not read as an empty backlog. */
  readonly awaitingAgent = signal(0);

  readonly current = computed(() => this.cases()[this.index()] ?? null);
  readonly done = computed(() => this.current() === null);
  readonly total = computed(() => this.cases().length);

  constructor() {
    this.load();
  }

  load(): void {
    this.busy.set(true);
    this.api.getRound().subscribe({
      next: (r) => {
        this.cases.set(r.cases);
        this.awaitingAgent.set(r.awaitingAgent ?? 0);
        this.index.set(0);
        this.busy.set(false);
      },
      error: () => {
        this.busy.set(false);
        // A load failure applied nothing — saying "could not apply that choice"
        // would name a write that never happened.
        this.toast.show({ message: this.i18n.t('curate.loadFailed'), kind: 'error' });
      },
    });
  }

  onChoose(optionId: string): void {
    const c = this.current();
    if (!c || this.busy()) return;
    this.busy.set(true);
    this.api.applyCase(c.id, optionId).subscribe({
      next: () => {
        this.busy.set(false);
        this.index.update((i) => i + 1);
      },
      error: () => {
        this.busy.set(false);
        this.toast.show({ message: this.i18n.t('curate.applyFailed'), kind: 'error' });
      },
    });
  }

  onSkip(): void {
    const c = this.current();
    if (!c || this.busy()) return;
    this.busy.set(true);
    this.api.skipCase(c.id).subscribe({
      next: () => {
        this.busy.set(false);
        this.index.update((i) => i + 1);
      },
      error: () => {
        // The deferral did not land, so the card may come back sooner than a
        // week — but the person asked to move on, and nothing was written.
        this.busy.set(false);
        this.toast.show({ message: this.i18n.t('curate.skipFailed'), kind: 'error' });
        this.index.update((i) => i + 1);
      },
    });
  }
}
