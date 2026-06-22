import { Component, input, computed } from '@angular/core';
import type { CandidateSource } from '../../lib/acquisition-candidate';

/**
 * Neutral per-row source chip for the blended acquisition results ("Soulseek",
 * "Internet Archive", "Spotify"). The point of source-agnostic UX: every source
 * gets the same visual weight — no "primary network" framing. Tone → theme
 * classes map here; nothing source-specific leaks beyond colour.
 */
@Component({
  selector: 'app-source-chip',
  standalone: true,
  template: `
    <span
      class="inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider"
      [class]="toneClass()"
      [attr.data-source]="source()"
      data-testid="source-chip"
    >
      {{ label() }}
    </span>
  `,
})
export class SourceChipComponent {
  readonly source = input.required<CandidateSource>();
  readonly label = input.required<string>();

  readonly toneClass = computed(() => {
    switch (this.source()) {
      case 'soulseek':
        return 'bg-indigo-500/15 text-indigo-300';
      case 'archive':
        return 'bg-amber-500/15 text-amber-300';
      case 'spotify':
        return 'bg-emerald-500/15 text-emerald-300';
      default:
        return 'bg-theme-surface-2 text-theme-muted';
    }
  });
}
