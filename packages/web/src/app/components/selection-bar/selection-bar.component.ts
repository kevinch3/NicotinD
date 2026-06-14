import { Component, input, output } from '@angular/core';
import { IconComponent } from '../icon/icon.component';

/**
 * Action bar shown while a track list is in multi-select mode. Stateless —
 * the host page owns the `Selection` (see `lib/selection.ts`) and feeds `count`
 * + `total`; this just renders the controls and emits intent.
 */
@Component({
  selector: 'app-selection-bar',
  imports: [IconComponent],
  templateUrl: './selection-bar.component.html',
})
export class SelectionBarComponent {
  readonly count = input(0);
  readonly total = input(0);
  /** Show a destructive Delete button (host decides the semantics + gating). */
  readonly canDelete = input(false);
  readonly deleteLabel = input('Delete');

  readonly selectAll = output<void>();
  readonly add = output<void>();
  readonly deleteSelected = output<void>();
  readonly cancel = output<void>();
}
