import { Component, input, output } from '@angular/core';
import { registerOverlayCloser } from '../../services/native/back-button.service';
import { BottomChromeSafeDirective } from '../../directives/bottom-chrome-safe.directive';

@Component({
  selector: 'app-confirm-dialog',
  standalone: true,
  imports: [BottomChromeSafeDirective],
  templateUrl: './confirm-dialog.component.html',
})
export class ConfirmDialogComponent {
  message = input.required<string>();
  confirmLabel = input<string>('Delete');
  confirm = output<void>();
  cancel = output<void>();

  constructor() {
    // Escape / hardware Back cancel via the shared stack (issue #398).
    registerOverlayCloser(() => this.cancel.emit());
  }
}
