import { Component, HostListener, input, output } from '@angular/core';
import { CommonModule } from '@angular/common';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [CommonModule],
  template: `
    <div class="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm"
         (click)="cancel.emit()">
      <div class="bg-theme-surface border border-theme rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl"
           (click)="$event.stopPropagation()">
        <p class="text-theme-primary text-sm mb-6">{{ message() }}</p>
        <div class="flex gap-3 justify-end">
          <button
            class="px-4 py-2 text-sm text-theme-secondary hover:text-theme-primary rounded-lg transition-colors"
            (click)="cancel.emit()">
            Cancel
          </button>
          <button
            class="px-4 py-2 text-sm bg-red-500/20 text-red-400 hover:bg-red-500/30 rounded-lg transition-colors"
            (click)="confirm.emit()">
            {{ confirmLabel() }}
          </button>
        </div>
      </div>
    </div>
  `,
})
export class ConfirmDialogComponent {
  message = input.required<string>();
  confirmLabel = input<string>('Delete');
  confirm = output<void>();
  cancel = output<void>();

  @HostListener('document:keydown.escape')
  onEscape() {
    this.cancel.emit();
  }
}
