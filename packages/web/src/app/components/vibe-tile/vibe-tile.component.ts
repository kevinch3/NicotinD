import { Component, input, output } from '@angular/core';

/**
 * One tappable "start something" tile, shared by the two rows of the home
 * page's Start-a-radio block.
 *
 * The block deliberately renders one component twice rather than two
 * components: a vibe and a genre are the same gesture (tap → filter radio),
 * so they must not drift apart visually. What separates them is `tone` —
 * a vibe is `color` (its own fixed gradient, bold white label, 2x wide) and a
 * genre is `muted` (flat themed surface, small secondary label, 1x wide), so
 * the genres read as the quiet index they are and never compete with the vibes.
 *
 * The gradient is a fixed Tailwind pair, not a `--theme-*` token, on purpose:
 * a theme-derived gradient collapses to grey under the OLED and light themes,
 * which would erase the very contrast the two tones exist to create.
 */
@Component({
  selector: 'app-vibe-tile',
  standalone: true,
  // The host carries the caller's data-testid as a plain attribute (a signal
  // input can't: the JIT vitest harness never registers inputs on a nested
  // component, so the binding silently never lands — testing/signal-input.ts,
  // landmine 1). `inline-flex` gives the host a real layout box over the
  // button, so a Playwright click on the testid lands on the control.
  host: { class: 'inline-flex' },
  template: `
    <button
      type="button"
      (click)="tapped.emit()"
      [disabled]="disabled()"
      [class]="classes()"
      [attr.aria-busy]="busy() ? 'true' : null"
    >
      @if (emoji()) {
        <span [class]="tone() === 'color' ? 'text-2xl' : 'text-base'" aria-hidden="true">{{
          emoji()
        }}</span>
      }
      <span [class]="labelClasses()">{{ label() }}</span>
      @if (busy()) {
        <span
          class="absolute top-2 right-2 w-3 h-3 rounded-full border-2 border-current border-t-transparent animate-spin"
        ></span>
      }
    </button>
  `,
})
export class VibeTileComponent {
  // Not `input.required()` — this component is nested inside RadioLandingComponent
  // and the JIT vitest harness doesn't register signal inputs on nested
  // components, so a required input throws NG0950 and takes down the HOST's
  // spec. See testing/signal-input.ts, landmine 1.
  readonly label = input('');
  readonly emoji = input<string | undefined>(undefined);
  /** `color` = a vibe (gradient, prominent); `muted` = a genre (grey, recessive). */
  readonly tone = input<'color' | 'muted'>('color');
  /** Tailwind gradient pair (e.g. `from-amber-400 to-orange-500`). Ignored when muted. */
  readonly gradient = input<string>('');
  /** 2x width — the vibe tiles are wide, the genre tiles are not. */
  readonly wide = input(false);
  readonly disabled = input(false);
  /** Shows the inline spinner while this tile's radio is being fetched. */
  readonly busy = input(false);

  readonly tapped = output<void>();

  classes(): string {
    const base =
      'relative shrink-0 flex flex-col justify-end gap-1 rounded-xl text-left ' +
      'transition active:scale-95 disabled:opacity-50 overflow-hidden';
    const size = this.wide() ? 'w-40 h-24 p-3' : 'w-[4.75rem] h-16 p-2';
    const skin =
      this.tone() === 'color'
        ? `bg-gradient-to-br ${this.gradient()} text-white shadow-sm hover:brightness-110`
        : 'bg-theme-surface-2/70 text-theme-secondary hover:bg-theme-surface-2';
    return `${base} ${size} ${skin}`;
  }

  labelClasses(): string {
    return this.tone() === 'color'
      ? 'text-sm font-bold leading-tight drop-shadow-sm'
      : 'text-xs font-medium leading-tight truncate';
  }
}
