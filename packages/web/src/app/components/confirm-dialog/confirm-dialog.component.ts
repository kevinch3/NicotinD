import { Component, HostListener, input, output } from '@angular/core';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [],
  templateUrl: './confirm-dialog.component.html',
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
