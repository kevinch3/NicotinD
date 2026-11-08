/**
 * The skip decision of the full Now Playing sheet
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

/** A Now Playing neighbour sliver (#1652): a `<button>` for its tap, but the
 *  cover is still what a drag from it grabs. */
export const NP_SLIVER = '[data-np-sliver]';

/** The element a gesture is judged from: a sliver stands in for the cover
 *  strip it sits on, so the button exclusions do not swallow its drags. */
export function gestureOrigin(target: EventTarget | null): EventTarget | null {
  if (!(target instanceof Element)) return target;
  return target.closest(NP_SLIVER)?.parentElement ?? target;
}

/** True when a pointerdown on `target` may start a skip swipe. */
export function canStartSkipSwipe(target: EventTarget | null): boolean {
  const origin = gestureOrigin(target);
  return !(origin instanceof Element && origin.closest(SKIP_SWIPE_EXCLUDE));
}

/** The scrolling queue/lyrics zone of the sheet: a sideways drag there is the
 *  panel's own (row swipe-remove, lyric scroll), never a skip. */
export const SKIP_SWIPE_PANEL_ZONE = '[data-np-zone="panel"]';

/** True when a pointerdown on `target` may start a skip on the full sheet:
 *  anywhere on it except the panel zone and the excluded controls. */
export function canStartSheetSkip(target: EventTarget | null): boolean {
  return (
    canStartSkipSwipe(target) &&
    !(target instanceof Element && target.closest(SKIP_SWIPE_PANEL_ZONE))
  );
}
