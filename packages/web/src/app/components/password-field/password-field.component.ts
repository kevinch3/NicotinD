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
  template: `
    <div class="relative" [class]="containerClass()">
      <input
        [type]="visible() ? 'text' : 'password'"
        [placeholder]="placeholder()"
        [autocomplete]="autocomplete()"
        [required]="required()"
        [value]="value()"
        (input)="onInputChange($event)"
        (blur)="onTouched()"
        [class]="'w-full pr-16 ' + inputClass()"
      />
      <button
        type="button"
        (click)="visible.set(!visible())"
        [attr.aria-label]="visible() ? 'Hide password' : 'Show password'"
        class="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs font-medium text-zinc-400 transition hover:text-zinc-100 hover:bg-zinc-700/60 focus:outline-none focus:ring-1 focus:ring-zinc-500"
      >
        {{ visible() ? 'Hide' : 'Show' }}
      </button>
    </div>
  `,
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
