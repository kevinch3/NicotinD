import { Component, input, output, signal, forwardRef } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Component({
  selector: 'app-password-field',
  // Angular's default host display is `inline`, which collapses to a ~24px line box
  // regardless of the `px-4 py-3` input inside it — a sibling's `space-y-*` margin then
  // measures from that collapsed box instead of the input's real height, eating the gap
  // (issue #832). `block` lets the host size to its content like a native <input> would.
  host: { class: 'block' },
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => PasswordFieldComponent),
      multi: true,
    },
  ],
  templateUrl: './password-field.component.html',
})
export class PasswordFieldComponent implements ControlValueAccessor {
  readonly placeholder = input('');
  readonly autocomplete = input('current-password');
  readonly required = input(false);
  readonly inputClass = input('');
  readonly containerClass = input('');
  /** Optional data-testid forwarded to the inner <input> (for e2e selectors). */
  readonly testId = input('');

  readonly visible = signal(false);
  readonly value = signal('');

  onChange: (val: string) => void = () => {};
  onTouched: () => void = () => {};

  writeValue(val: string): void {
    this.value.set(val ?? '');
  }

  registerOnChange(fn: (val: string) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  onInputChange(event: Event): void {
    const val = (event.target as HTMLInputElement).value;
    this.value.set(val);
    this.onChange(val);
  }
}
