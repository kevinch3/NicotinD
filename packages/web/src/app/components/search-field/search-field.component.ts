import { Component, input, output } from '@angular/core';
import { IconComponent } from '../icon/icon.component';
import { TranslatePipe } from '../../pipes/translate.pipe';

/**
 * The list toolbar's search box: it takes whatever width the row's icon
 * controls leave (`flex-1 min-w-0`), and carries an optional trailing `hint`
 * (a result count) inside the field instead of beside it, so the row never
 * needs a second line. `placeholder` and `label` are i18n keys.
 */
@Component({
  selector: 'app-search-field',
  imports: [IconComponent, TranslatePipe],
  templateUrl: './search-field.component.html',
  host: { class: 'flex min-w-0 flex-1' },
})
export class SearchFieldComponent {
  readonly value = input('');
  readonly placeholder = input('');
  readonly label = input('');
  readonly testId = input('');
  /** Already-formatted trailing text, e.g. "3 matches"; empty renders nothing. */
  readonly hint = input('');
  readonly hintTestId = input('');

  readonly valueChange = output<string>();
}
