import { Component, input, computed } from '@angular/core';
import type { CandidateSource } from '../../lib/acquisition-candidate';
import type { LinkSource } from '../../lib/link-intent';

/** Sources the chip can render: blended-result sources plus link-intent hosts. */
export type ChipSource = CandidateSource | LinkSource;

/**
 * Source → tone class. Kept a pure, exported function (not inline in the
 * computed) so it's unit-testable under JIT vitest, which can't drive
 * `input.required` signals. The returned classes are theme-aware
 * (`chip-tone-*` in styles.css derive both tint + text via `color-mix` against
 * the active theme tokens) — a previous version hardcoded Tailwind palette
 * tints like `text-indigo-300`, which rendered near-invisible on light themes
 * (daylight/warm-paper/eink).
 */
export function sourceChipToneClass(source: ChipSource): string {
  switch (source) {
    case 'soulseek':
      return 'chip-tone-soulseek';
    case 'archive':
      return 'chip-tone-archive';
    case 'spotify':
      return 'chip-tone-spotify';
    default:
      return 'bg-theme-surface-2 text-theme-muted';
  }
}

/**
 * Neutral per-row source chip for the blended acquisition results ("Soulseek",
 * "Internet Archive", "Spotify"). The point of source-agnostic UX: every source
 * gets the same visual weight — no "primary network" framing. Tone → theme
 * classes map here; nothing source-specific leaks beyond colour.
 */
@Component({
  selector: 'app-source-chip',
  standalone: true,
  templateUrl: './source-chip.component.html',
})
export class SourceChipComponent {
  readonly source = input.required<ChipSource>();
  readonly label = input.required<string>();

  readonly toneClass = computed(() => sourceChipToneClass(this.source()));
}
