import { Component, inject } from '@angular/core';
import { ConfirmService } from '../../services/confirm.service';

@Component({
  selector: 'app-confirm-host',
  template: `
    @if (confirm.request(); as req) {
      <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
           data-testid="confirm-dialog" (click)="confirm.resolve(false)">
        <div class="bg-theme-surface border border-theme rounded-xl p-6 max-w-sm w-full shadow-2xl"
             (click)="$event.stopPropagation()">
          <p class="text-sm text-theme-primary mb-6">{{ req.message }}</p>
          <div class="flex gap-3 justify-end">
            <button type="button" data-testid="confirm-cancel"
              class="px-4 py-2 rounded-lg text-theme-secondary hover:bg-theme-hover transition"
              (click)="confirm.resolve(false)">Cancel</button>
            <button type="button" data-testid="confirm-ok"
              class="px-4 py-2 rounded-lg status-error hover:opacity-80 transition"
              (click)="confirm.resolve(true)">Confirm</button>
          </div>
        </div>
      </div>
    }
  `,
})
export class ConfirmHostComponent {
  readonly confirm = inject(ConfirmService);
}
