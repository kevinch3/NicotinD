import { Component, input, output, signal } from '@angular/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import type { CaseOption, CurationCase } from '../../services/api/api-types';

/**
 * One decision, rendered (docs/curator-triage.md "Closed options only").
 *
 * The card is read on a phone between two songs, so it shows exactly what a
 * decision needs and nothing else: the target, one sentence, and the closed
 * options. The raiser's research and the evidence rows are there, but folded
 * — the reviewer opens them when a choice is not obvious, not before every
 * choice. A destructive option asks once more before it fires.
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

  /** The destructive option waiting for its second tap, if any. */
  readonly confirming = signal<string | null>(null);

  /** The eyebrow reads the decision SHAPE; the raw union member is not copy. */
  kindKey(kind: CurationCase['kind']): string {
    return `curate.kind.${kind}`;
  }

  /** The server-appended "change nothing" choice, rendered through i18n. */
  isFallback(o: CaseOption): boolean {
    return o.id === 'resolve';
  }

  pick(o: CaseOption): void {
    if (o.destructive && this.confirming() !== o.id) {
      this.confirming.set(o.id);
      return;
    }
    this.confirming.set(null);
    this.choose.emit(o.id);
  }

  cancelConfirm(): void {
    this.confirming.set(null);
  }
}
