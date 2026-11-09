import { Component, DestroyRef, computed, inject, input, output, signal } from '@angular/core';
import { LYRICS_OFFSET_STEP_MS } from '@nicotind/core';
import { TranslatePipe } from '../../../pipes/translate.pipe';
import { HapticDirective } from '../../../directives/haptic.directive';

/** A held button repeats after this long… */
export const HOLD_DELAY_MS = 400;
/** …every this often… */
export const HOLD_REPEAT_MS = 100;
/** …and after this long held, each repeat moves a whole second. */
export const HOLD_COARSE_AFTER_MS = 2000;
export const HOLD_COARSE_STEP_MS = 1000;

/** The step a repeat moves by, `heldMs` after the press began (#1656). */
export function holdStepMs(heldMs: number): number {
  return heldMs >= HOLD_COARSE_AFTER_MS ? HOLD_COARSE_STEP_MS : LYRICS_OFFSET_STEP_MS;
}

/**
 * The lyrics sync tool, one copy for the Lyrics panel and fullscreen karaoke
 * (#1656, docs/lyrics-options.md §5).
 *
 * - **Fixed geometry.** Every slot is always rendered at a constant width, and
 *   Reset is disabled at zero rather than removed, so nothing moves under the
 *   finger when the value changes. A Reset that appeared on the first tap
 *   moved both buttons 20 px, and the second tap missed.
 * - **Direction in words.** "Lyrics earlier" / "Lyrics later", and the value
 *   reads "Lyrics 0.25 s later". The stored sign is unchanged: positive shows
 *   the lines later.
 * - **Press and hold** repeats, and speeds up to whole seconds. The shell
 *   serializes the writes, so a hold never sends one PATCH per step.
 */
@Component({
  selector: 'app-lyrics-sync-tool',
  imports: [TranslatePipe, HapticDirective],
  templateUrl: './lyrics-sync-tool.component.html',
})
export class LyricsSyncToolComponent {
  /** Stored sync correction; positive shows the lines later. */
  readonly offsetMs = input(0);
  /** `overlay` sits on the karaoke gradient; `panel` on the theme surface. */
  readonly tone = input<'overlay' | 'panel'>('panel');
  /** Prefix of every `data-testid`, so each surface keeps its own. */
  readonly testid = input('lyrics-sync');

  /** The delta in ms; the tool does not own the stored offset. */
  readonly nudged = output<number>();
  readonly reset = output<void>();

  /** The last step taken, shown briefly as confirmation of what a tap did. */
  readonly lastStep = signal<number | null>(null);

  readonly seconds = computed(() => (Math.abs(this.offsetMs()) / 1000).toFixed(2));

  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private repeatTimer: ReturnType<typeof setInterval> | null = null;
  private flashTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.release();
      if (this.flashTimer) clearTimeout(this.flashTimer);
    });
  }

  /** A pointer press: one step now, then a repeat while it is held. */
  press(direction: -1 | 1, event: PointerEvent): void {
    event.preventDefault();
    this.release();
    this.step(direction * LYRICS_OFFSET_STEP_MS);
    const began = Date.now();
    this.holdTimer = setTimeout(() => {
      this.repeatTimer = setInterval(
        () => this.step(direction * holdStepMs(Date.now() - began)),
        HOLD_REPEAT_MS,
      );
    }, HOLD_DELAY_MS);
  }

  /** Pointer up, leave or cancel ends a hold. */
  release(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    if (this.repeatTimer) clearInterval(this.repeatTimer);
    this.holdTimer = null;
    this.repeatTimer = null;
  }

  /**
   * Keyboard activation (Enter/Space dispatch a click with `detail === 0`). A
   * pointer press already stepped in `press`, so its click is ignored.
   */
  keyClick(direction: -1 | 1, event: MouseEvent): void {
    if (event.detail === 0) this.step(direction * LYRICS_OFFSET_STEP_MS);
  }

  private step(deltaMs: number): void {
    this.nudged.emit(deltaMs);
    this.lastStep.set(deltaMs);
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => this.lastStep.set(null), 1200);
  }
}
