import { Component, input, signal, computed, inject } from '@angular/core';
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

  readonly imgError = signal(false);

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
