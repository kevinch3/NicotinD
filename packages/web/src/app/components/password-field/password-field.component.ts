import { Component, input, output, signal, forwardRef } from '@angular/core';
import { ControlValueAccessor, NG_VALUE_ACCESSOR } from '@angular/forms';

@Component({
  selector: 'app-password-field',
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
