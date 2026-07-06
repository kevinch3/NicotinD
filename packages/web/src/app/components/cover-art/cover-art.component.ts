import { Component, input, signal, computed, effect, inject } from '@angular/core';
import { ServerConfigService } from '../../services/server-config.service';

export function hashCode(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/**
 * Coverless placeholder gradient, built from the active theme's tokens
 * (`--theme-accent` / `--theme-surface-2`, resolved live from [data-theme] on
 * <html>) so it reads as generic-but-on-theme and restyles instantly when the
 * user changes themes. The angle varies deterministically per item so a grid of
 * placeholders isn't a flat wall of identical tiles.
 */
export function placeholderGradient(artist: string, album: string): string {
  const angle = hashCode(`${artist}:${album}`) % 360;
  return `linear-gradient(${angle}deg, var(--theme-accent), var(--theme-surface-2))`;
}

/** The single letter shown over the placeholder gradient. */
export function placeholderInitial(album: string, artist: string): string {
  return (album || artist || '?')[0].toUpperCase();
}

/** Fallback-initial font size: scales with px size, or a default when filling. */
export function placeholderFontSize(size: number | undefined, fill: boolean): string {
  return fill || size == null ? '2rem' : `${size * 0.35}px`;
}

/**
 * Native `<img loading>` value for a cover. Covers default to `lazy` so a grid of
 * tiles doesn't fire dozens of eager requests; an above-the-fold cover passes
 * `eager`. Pure so it's unit-testable without driving the `input()` (the JIT
 * vitest harness can't set signal inputs).
 */
export function coverLoadingAttr(eager: boolean): 'eager' | 'lazy' {
  return eager ? 'eager' : 'lazy';
}

@Component({
  selector: 'app-cover-art',
  templateUrl: './cover-art.component.html',
})
export class CoverArtComponent {
  private server = inject(ServerConfigService);

  readonly src = input<string | undefined>(undefined);
  // Rewrites a relative `/api/cover/...` src to the configured server origin so
  // covers load in the native shell (no-op on web). External URLs (e.g. Lidarr
  // artwork) and undefined pass through untouched. This is the single chokepoint
  // for every `<app-cover-art>` in the app.
  readonly resolvedSrc = computed(() => this.server.apiUrl(this.src() ?? '') || undefined);
  readonly artist = input('');
  readonly album = input('');
  /** Fixed square size in px. Ignored (and optional) when `fill` is set. */
  readonly size = input<number | undefined>(undefined);
  /** Fill the parent (w-full aspect-square) instead of a fixed px size — for responsive grid tiles. */
  readonly fill = input(false);
  readonly className = input('');
  readonly rounded = input('rounded');
  // Covers lazy-load + async-decode by default so a grid of tiles doesn't fire
  // dozens of eager, main-thread-decoded image requests at once. Set `eager` for
  // the always-visible above-the-fold cover (e.g. the player bar) so it isn't
  // deferred. Mirrors the native `<img loading>` semantics.
  readonly eager = input(false);
  readonly loadingAttr = computed<'eager' | 'lazy'>(() => coverLoadingAttr(this.eager()));

  readonly imgError = signal(false);
  readonly imgLoaded = signal(false);

  constructor() {
    // Reset loading/error state when the resolved src changes so the gradient
    // placeholder re-appears while new image bytes are in flight.
    effect(() => {
      this.resolvedSrc();
      this.imgLoaded.set(false);
      this.imgError.set(false);
    });
  }

  get initialFontSize(): string {
    return placeholderFontSize(this.size(), this.fill());
  }

  get gradient(): string {
    return placeholderGradient(this.artist(), this.album());
  }

  get initial(): string {
    return placeholderInitial(this.album(), this.artist());
  }
}
