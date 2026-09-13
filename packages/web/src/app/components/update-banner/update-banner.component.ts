import { Component, inject } from '@angular/core';
import { UpdateService } from '../../services/update.service';
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
        data-testid="update-banner"
        class="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between gap-4 px-4 py-3 border-t"
        style="background: var(--theme-surface); border-color: var(--theme-border); color: var(--theme-text-primary);"
      >
        <span class="text-sm" style="color: var(--theme-text-secondary);">
          {{ (update.applying() ? 'settings.updateApplying' : 'settings.updateAvailable') | t }}
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
export class UpdateBannerComponent {
  readonly update = inject(UpdateService);
}
