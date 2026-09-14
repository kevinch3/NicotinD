import { signal } from '@angular/core';

/**
 * Karaoke browse mode — the fullscreen overlay's two views and the rule that
 * moves between them.
 *
 * The overlay opens on a 2-line auto-follow view (current line + next), which
 * fits a narrow window without wrapping. A wheel/touch gesture or ▲ ▼ on the
 * lyrics body enters **browse**: the full masked-scroll list with tap-to-seek.
 * Browse leaves again on a seek, on the explicit toggle, or after `IDLE_MS` of
 * silence, so a stray scroll never strands the singer on the list.
 *
 * Shared by the phone sheet and the TV player (#1134): the rule is the same on
 * both, and two copies of a timer-driven state machine are how two surfaces
 * drift apart without a test noticing.
 */
export class KaraokeBrowseMode {
  static readonly IDLE_MS = 4000;

  /** `false` = auto-follow, `true` = the full browse list. */
  readonly browsing = signal(false);
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** A wheel/touch/arrow interaction on the lyrics body: enter (or stay in)
   *  browse and restart the idle countdown. */
  interact(): void {
    this.browsing.set(true);
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.browsing.set(false);
    }, KaraokeBrowseMode.IDLE_MS);
  }

  /** The visible browse button and keyboard entry: flip between the views. */
  toggle(): void {
    if (this.browsing()) this.leave();
    else this.interact();
  }

  /** Back to auto-follow at once — after a seek, or when the overlay closes. */
  leave(): void {
    this.clearTimer();
    this.browsing.set(false);
  }

  /** Call on destroy so the idle timeout can never fire past the owner. */
  destroy(): void {
    this.clearTimer();
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}
