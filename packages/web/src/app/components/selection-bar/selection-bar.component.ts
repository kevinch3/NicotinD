import { Component, input, output } from '@angular/core';

/**
 * Action bar shown while a track list is in multi-select mode. Stateless —
 * the host page owns the `Selection` (see `lib/selection.ts`) and feeds `count`
 * + `total`; this just renders the controls and emits intent.
 */
@Component({
  selector: 'app-selection-bar',
  imports: [],
  templateUrl: './selection-bar.component.html',
})
export class SelectionBarComponent {
  readonly count = input(0);
  readonly total = input(0);

  readonly selectAll = output<void>();
  readonly add = output<void>();
  readonly cancel = output<void>();
}
