import {
  Component,
  type ElementRef,
  type OnDestroy,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { UpdateService } from '../../services/update.service';
import { UPDATE_BANNER_HEIGHT_VAR, updateBannerReservation } from '../../lib/player-chrome';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * The update strip.
 *
 * It used to be the *only* way a staged update ever applied — a bar with a
 * "Reload to update" button that costs nothing to ignore, which is how an
 * installed PWA ends up months behind (#1126). `UpdateService` now applies the
 * update by itself at the first safe moment (see `lib/update-policy.ts`), so
 * this is a status line with an impatient button rather than a prompt: it says
 * what is about to happen, and offers to do it now.
 */
@Component({
  selector: 'app-update-banner',
  imports: [TranslatePipe],
  template: `
    @if (update.updateAvailable()) {
      <div
        #strip
        data-testid="update-banner"
        class="fixed bottom-[calc(-1*var(--vp-deficit))] left-0 right-0 z-50 flex items-center justify-between gap-4 px-4 py-3 border-t"
        style="background: var(--theme-surface); border-color: var(--theme-border); color: var(--theme-text-primary);"
      >
        <span class="text-sm" style="color: var(--theme-text-secondary);">
          {{ (update.applying() ? 'settings.updateApplying' : 'settings.updateAvailable') | t }}
          @if (update.targetBuild(); as build) {
            <span class="ml-1 font-mono text-xs opacity-70" data-testid="update-banner-build">{{
              build.slice(0, 7)
            }}</span>
          }
        </span>
        @if (!update.applying()) {
          <button
            (click)="update.applyUpdate()"
            data-testid="update-banner-apply"
            class="shrink-0 rounded px-3 py-1 text-sm font-medium transition-opacity hover:opacity-80"
            style="background: var(--theme-accent); color: #fff;"
          >
            {{ 'settings.reload' | t }}
          </button>
        }
      </div>
    }
  `,
})
export class UpdateBannerComponent implements OnDestroy {
  readonly update = inject(UpdateService);

  private readonly strip = viewChild<ElementRef<HTMLElement>>('strip');
  private readonly stripHeight = signal(0);

  constructor() {
    // The toast stack clears the strip by this height (#1699), as it clears the
    // mini player by `--mini-player-h`.
    effect((onCleanup) => {
      const el = this.strip()?.nativeElement;
      if (!el) {
        this.stripHeight.set(0);
        return;
      }
      const measure = () => this.stripHeight.set(el.getBoundingClientRect().height);
      measure();
      if (typeof ResizeObserver === 'undefined') return;
      const observer = new ResizeObserver(measure);
      observer.observe(el, { box: 'border-box' });
      onCleanup(() => observer.disconnect());
    });
    effect(() => {
      document.documentElement.style.setProperty(
        UPDATE_BANNER_HEIGHT_VAR,
        updateBannerReservation(this.update.updateAvailable(), this.stripHeight()),
      );
    });
  }

  ngOnDestroy(): void {
    document.documentElement.style.removeProperty(UPDATE_BANNER_HEIGHT_VAR);
  }
}
