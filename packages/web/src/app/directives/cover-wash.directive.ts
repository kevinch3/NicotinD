import { Directive, ElementRef, Input, effect, inject, signal } from '@angular/core';
import { loadCoverPalette } from '../lib/cover-colors';
import { coverWash, parseRgb, type Rgb } from '../lib/cover-wash';
import { ThemeService } from '../services/theme.service';

/**
 * Tints its host with the artwork's dominant colour (#1687, theme audit Q3 B).
 *
 * `[appCoverWash]="coverUrl"` sets `--theme-cover-wash` on the host, which the
 * `.cover-wash` class paints as a flat layer over whatever background the host
 * already has. The colour and its alpha come from `coverWash`, measured against
 * the preset's own tokens, so the tint never costs the text its contrast.
 *
 * No wash on E-Ink or under `prefers-contrast: more`, and none for a cover that
 * cannot be read. It is recomputed when the cover or the theme changes.
 */
@Directive({
  selector: '[appCoverWash]',
  host: { class: 'cover-wash' },
})
export class CoverWashDirective {
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef).nativeElement;
  private readonly theme = inject(ThemeService, { optional: true });

  private readonly src = signal<string | null>(null);
  private readonly over = signal<'bg' | 'surface'>('bg');

  /** The cover's URL; null or empty clears the wash. Classic inputs, so a
   *  parent's binding reaches them in the unit harness too. */
  @Input() set appCoverWash(src: string | null | undefined) {
    this.src.set(src || null);
  }
  /** Which token the host's own background is: the page or a card. */
  @Input() set coverWashOver(level: 'bg' | 'surface') {
    this.over.set(level);
  }

  private run = 0;

  constructor() {
    effect(() => {
      const src = this.src();
      const over = this.over();
      // Read so a preset change recomputes against the new tokens.
      this.theme?.theme();
      this.theme?.systemTheme?.();
      const run = ++this.run;
      if (!src) {
        this.apply(null);
        return;
      }
      // Measured after the image loads, by which time a preset change made in
      // the same tick has reached the document.
      void loadCoverPalette(src).then((palette) => {
        if (run !== this.run) return;
        this.apply(washDisabled() ? null : washFor(palette.dominant, over));
      });
    });
  }

  private apply(css: string | null): void {
    if (css) this.host.style.setProperty('--theme-cover-wash', css);
    else this.host.style.removeProperty('--theme-cover-wash');
  }
}

/** E-Ink has no colour to give, and a high-contrast request outranks decoration. */
function washDisabled(): boolean {
  if (typeof document === 'undefined') return true;
  if (document.documentElement.getAttribute('data-theme') === 'eink') return true;
  return (
    typeof window.matchMedia === 'function' && window.matchMedia('(prefers-contrast: more)').matches
  );
}

/** The wash for a dominant colour over the current preset's `bg` or `surface`. */
export function washFor(dominant: string | undefined, over: 'bg' | 'surface'): string | null {
  const top = parseRgb(dominant);
  if (!top) return null;
  const cs = getComputedStyle(document.documentElement);
  const token = (name: string): Rgb | null => parseRgb(cs.getPropertyValue(`--theme-${name}`));
  const surface = token(over === 'bg' ? 'bg' : 'surface');
  const texts = [token('text-primary'), token('text-secondary'), token('text-muted')];
  if (!surface || texts.some((t) => !t)) return null;
  return coverWash(top, surface, texts as Rgb[])?.css ?? null;
}
