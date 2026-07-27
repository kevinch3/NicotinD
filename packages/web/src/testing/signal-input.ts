import { ɵSIGNAL as SIGNAL } from '@angular/core';

/**
 * Set an Angular signal `input()` from a unit test.
 *
 * The web unit suite runs on the **JIT vitest harness** (`@angular/compiler` +
 * the template inliner, no ngtsc build step — see docs/web-ui.md "Web test
 * harness"), which does not register signal inputs on the component definition.
 * So the supported API is unavailable and we write the signal node directly.
 *
 * **The supported path was measured, not assumed.** `componentRef.setInput()`
 * is a silent **no-op** here — with *and* without a following
 * `fixture.detectChanges()`, the input keeps its default and every downstream
 * `computed()` reads the default. It does not throw, which is what makes it
 * dangerous: a spec written that way passes vacuously against defaults. Don't
 * re-litigate it without re-running that check; if a future
 * `@analogjs/vite-plugin-angular` registers inputs properly, this whole module
 * can be deleted in favour of `setInput`.
 *
 * ## Two landmines this harness sets, both already paid for
 *
 * 1. **Never use `input.required<T>()` on a component intended to be nested.**
 *    The harness doesn't register signal inputs on a *nested imported*
 *    component, so Angular reports `NG0303: Can't bind to 'x' since it isn't a
 *    known property of 'app-y'`. The binding never lands, so an
 *    `input.required()` then throws `NG0950: Input is required but no value is
 *    available yet` **during change detection** — which takes down the **host**
 *    component's entire spec, not just the child's. Prefer
 *    `input<T>(someDefault)`, which is the better contract anyway. Two
 *    consecutive CI failures on PR #252 came from not knowing this.
 *
 * 2. **Call this BEFORE the fixture's first `detectChanges()`, and create a
 *    fresh component per scenario.** The raw `.value` write deliberately
 *    bypasses `signalSetFn`, so nothing that has *already read* the signal is
 *    notified — consumers keep rendering the stale value. That is also the
 *    mechanism behind the "two consecutive writes to one input don't re-publish
 *    downstream `computed()`s" symptom: the second write lands in the node but
 *    never invalidates the readers, so an assertion after it can silently check
 *    the *first* value. One instance per scenario sidesteps both.
 *
 *    The exemption: a spec that reads a **pure computed directly** and never
 *    goes through a rendered fixture has no readers to go stale, so ordering
 *    doesn't bite (`track-stats-bars`, `genre-radar`). Rely on that only when
 *    the spec genuinely never renders.
 *
 * @example
 * const fixture = TestBed.createComponent(DiskPillComponent);
 * setInputValue(fixture.componentInstance.usage, { usedBytes: 1, totalBytes: 2 });
 */
export function setInputValue<T>(inputSignal: () => T, value: T): void {
  (inputSignal as unknown as Record<typeof SIGNAL, { value: T }>)[SIGNAL].value = value;
}
