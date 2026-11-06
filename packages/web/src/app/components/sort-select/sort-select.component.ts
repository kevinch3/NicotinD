import { Component, computed, input, output } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';
import type { SortOption } from '../../services/list-controls.service';

/** One sort choice; `label` is an i18n key (plain text falls through `t` unchanged). */
export interface SortChoice {
  value: string;
  label: string;
}

export type SortDirection = 'asc' | 'desc';

/** `ListControlsService` sorts by `field`; the sort control speaks `value`. */
export function toSortChoices(options: readonly SortOption[]): SortChoice[] {
  return options.map((o) => ({ value: o.field, label: o.label }));
}

/**
 * The list toolbar's sort control as one icon: a native `<select>` laid
 * transparently over the sort glyph, so a phone still gets its own picker and
 * every existing `selectOption` / `toHaveValue` call keeps working. The
 * optional direction toggle sits beside it. Host is `contents`, so both
 * buttons are flex items of the toolbar row they are placed in.
 */
@Component({
  selector: 'app-sort-select',
  imports: [IconComponent, TranslatePipe],
  templateUrl: './sort-select.component.html',
  host: { class: 'contents' },
})
export class SortSelectComponent {
  readonly options = input<readonly SortChoice[]>([]);
  readonly value = input('');
  /** i18n key for the select's accessible name, e.g. `library.sortLabel.albums`. */
  readonly label = input('');
  readonly testId = input('');
  /** `null` renders no direction toggle (a server-ordered list has none). */
  readonly direction = input<SortDirection | null>(null);
  readonly directionTestId = input('');

  readonly valueChange = output<string>();
  readonly directionToggle = output<void>();

  readonly currentLabel = computed(
    () => this.options().find((o) => o.value === this.value())?.label ?? '',
  );
}
