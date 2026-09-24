/**
 * The skip decision shared by the Now Playing cover and the mini bar
 * (issue #1297): a leftward swipe goes to the next track, a rightward one to
 * the previous, each committing past `SKIP_THRESHOLD_PX` or on a flick, by the
 * same `shouldCommit` rule as the vertical swipes. See docs/web-ui.md
 * "Swipe to skip".
 */
import { shouldCommit } from './vertical-swipe';

export const SKIP_THRESHOLD_PX = 80;

/** Controls and nested drags keep their pointer: a skip never starts on them. */
export const SKIP_SWIPE_EXCLUDE =
  'button, a, input, select, textarea, [data-seek], .seek-range, app-now-playing-waveform, app-menu-panel';

export function skipDirection(dx: number, velocity: number): 'next' | 'prev' | null {
  const opts = { thresholdPx: SKIP_THRESHOLD_PX };
  if (shouldCommit(-dx, -velocity, opts)) return 'next';
  if (shouldCommit(dx, velocity, opts)) return 'prev';
  return null;
}

/** True when a pointerdown on `target` may start a skip swipe. */
export function canStartSkipSwipe(target: EventTarget | null): boolean {
  return !(target instanceof Element && target.closest(SKIP_SWIPE_EXCLUDE));
}
