import { Directive, Input } from '@angular/core';
import { haptic, type HapticEvent } from '../lib/haptics';

/**
 * `<button appHaptic="tap">` — the template door into `lib/haptics.ts` (#1659):
 * the host's click fires the named event, so a button whose output is pure
 * (`playPauseClicked.emit()`) gains feedback without a handler of its own. A
 * bare `appHaptic` is a `tap`. Gating, throttling and platform choice all live
 * in `haptic()`.
 */
@Directive({
  selector: '[appHaptic]',
  standalone: true,
  host: { '(click)': 'fire()' },
})
export class HapticDirective {
  // A classic `@Input`: the JIT test harness does not discover `input()` fields
  // on directives (src/testing/signal-input.ts).
  @Input({ alias: 'appHaptic' }) event: HapticEvent | '' = 'tap';

  fire(): void {
    haptic(this.event || 'tap');
  }
}
