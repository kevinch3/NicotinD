import { Component, computed, input } from '@angular/core';

const DEFAULT_ICON = 'play' as const;

/**
 * app-icon — a small, centralized set of the universal-action glyphs the app
 * uses on icon-only buttons (back, play, download, share, close, add, delete).
 * Before this, each was a hand-copied inline `<svg>` (Back lived in 3 files,
 * Download in 2, …); centralizing keeps them consistent and gives the e-ink
 * `[data-theme=eink] svg { stroke-width }` rule a single shape to thicken.
 *
 * The icon is decorative (`aria-hidden`): the *button* carries the accessible
 * name via `aria-label` + `title`. Glyphs are lucide-style (24 viewBox,
 * stroke-width 2) to match the rest of the app's inline icons.
 */
export type IconName = 'back' | 'play' | 'download' | 'share' | 'close' | 'add' | 'delete';

/** Play is the only filled glyph; the rest are stroked outlines. DI-free so the
 *  branch is unit-testable (the JIT harness can't drive the `name` input). */
export function isFilledIcon(name: IconName): boolean {
  return name === 'play';
}

@Component({
  selector: 'app-icon',
  templateUrl: './icon.component.html',
})
export class IconComponent {
  // Not `input.required`: consumers always set it, but a required signal throws
  // NG0950 under the web JIT test harness (it can't satisfy the input during the
  // first change detection), which would break every spec that renders a button.
  readonly name = input<IconName>(DEFAULT_ICON);
  /** Square size in px. */
  readonly size = input(18);
  readonly filled = computed(() => isFilledIcon(this.name()));
}
