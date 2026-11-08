import { Component, inject } from '@angular/core';
import { ToastService } from '../../services/toast.service';
import { TOAST_STACK_BOTTOM_CLASS } from '../../lib/player-chrome';

@Component({
  selector: 'app-toast-outlet',
  standalone: true,
  templateUrl: './toast-outlet.component.html',
})
export class ToastOutletComponent {
  readonly toastService = inject(ToastService);
  readonly stackBottomClass = TOAST_STACK_BOTTOM_CLASS;
}
