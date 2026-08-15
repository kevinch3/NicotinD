import { Component, input, signal, computed } from '@angular/core';
// why: this card is nested inside plugins.component, and the JIT vitest harness
// throws NG0950 on a required input of a nested component (see
// src/testing/signal-input.ts). An optional input + a template guard is the
// robust contract; callers always bind an entry in practice.
import { renderComposeSnippet } from '@nicotind/core';
import { TranslatePipe } from '../../pipes/translate.pipe';
import { TvNavItemDirective } from '../../directives/tv-nav-item.directive';
import type { AddonCatalogItem } from '../../services/addon-catalog.service';

/**
 * One card in the Extensions "Available add-ons" marketplace (issue #517).
 *
 * PR1 is read-only: it shows the vetted entry + its install state and, on
 * "Set up", the generated docker-compose snippet (a placeholder token here — the
 * minted-token one-click install arrives in PR2). Builtin (archive) and
 * already-installed entries render a static badge with no setup step.
 */
@Component({
  selector: 'app-addon-catalog-card',
  standalone: true,
  imports: [TranslatePipe, TvNavItemDirective],
  templateUrl: './addon-catalog-card.component.html',
})
export class AddonCatalogCardComponent {
  readonly entry = input<AddonCatalogItem>();
  readonly open = signal(false);
  readonly copied = signal(false);

  /** The compose snippet for this entry. PR1 uses a placeholder token; PR2 will
   *  swap in a server-minted one via the install route. */
  readonly snippet = computed(() => {
    const e = this.entry();
    return e
      ? renderComposeSnippet(e, 'change-me-to-a-long-random-secret')
      : { services: '', volumes: [], command: '', full: '' };
  });

  /** Non-builtin, not-yet-installed entries are the ones with a setup step. */
  readonly canSetUp = computed(() => this.entry()?.state === 'available');

  toggle(): void {
    this.open.update((v) => !v);
  }

  async copySnippet(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.snippet().full);
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // Clipboard unavailable (insecure context / denied) — the text stays
      // selectable in the <pre>, so this is a non-fatal nicety.
    }
  }
}
