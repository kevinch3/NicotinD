import { Component, inject } from '@angular/core';
import { UpdateService } from '../../services/update.service';

@Component({
  selector: 'app-update-banner',
  template: `
    @if (update.updateAvailable()) {
      <div class="fixed bottom-0 left-0 right-0 z-50 flex items-center justify-between gap-4 px-4 py-3 border-t"
           style="background: var(--theme-surface); border-color: var(--theme-border); color: var(--theme-text-primary);">
        <span class="text-sm" style="color: var(--theme-text-secondary);">
          A new version of NicotinD is available.
        </span>
        <button
          (click)="update.applyUpdate()"
          class="shrink-0 rounded px-3 py-1 text-sm font-medium transition-opacity hover:opacity-80"
          style="background: var(--theme-accent); color: #fff;">
          Reload to update
        </button>
      </div>
    }
  `,
})
export class UpdateBannerComponent {
  readonly update = inject(UpdateService);
}
