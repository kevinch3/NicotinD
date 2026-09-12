import { Component, input, output } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import type { CurationCase } from '../../services/api/api-types';

/**
 * One decision, rendered (docs/curator-triage.md §3).
 *
 * All three phase-1 kinds are the same shape — a question, its evidence, and a
 * typed option list — so they share one card. The `duplicate` A/B comparison
 * and the `batch` confirm genuinely differ and get their own cards in phase 3.
 */
@Component({
  selector: 'app-case-card',
  standalone: true,
  imports: [TranslatePipe],
  templateUrl: './case-card.component.html',
})
export class CaseCardComponent {
  readonly case = input<CurationCase | null>(null);
  readonly busy = input(false);

  readonly choose = output<string>();
  readonly skip = output<void>();
}
