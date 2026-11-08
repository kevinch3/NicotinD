export interface Point {
  x: number;
  y: number;
}

/**
 * Clamp a popup/menu's top-left so it stays fully within the viewport. A context
 * menu opened at a tap's raw coordinates otherwise overflows the right/bottom
 * edge on mobile (§G6). Keeps a small margin from every edge.
 *
 * `bottomInset` reserves space at the viewport bottom for fixed chrome (the
 * mini-player + mobile tab bar): the menu's bottom edge is clamped above it, so
 * a row menu near the end of a scrolled list never opens *under* the player/tab
 * bar where it'd be only partially visible.
 *
 * `topInset` is the same reservation at the top: the status bar / notch
 * (`env(safe-area-inset-top)`) and the sticky header. A menu flipped up from a
 * mid-screen trigger used to clamp to an 8px margin, under the iPhone status
 * bar (#1714).
 */
export function clampMenuPosition(
  pos: Point,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 200,
  menuHeight = 96,
  margin = 8,
  bottomInset = 0,
  topInset = 0,
): Point {
  const minY = topInset + margin;
  const maxX = Math.max(margin, viewportWidth - menuWidth - margin);
  const maxY = Math.max(minY, viewportHeight - bottomInset - menuHeight - margin);
  return {
    x: Math.min(Math.max(margin, pos.x), maxX),
    y: Math.min(Math.max(minY, pos.y), maxY),
  };
}

/**
 * The tallest a popover may be: the band between the top and bottom
 * reservations, less a margin at each end. A taller menu scrolls inside that
 * band instead of overflowing it (a 13-item song menu on a landscape phone).
 */
export function menuMaxHeight(
  viewportHeight: number,
  topInset = 0,
  bottomInset = 0,
  margin = 8,
): number {
  return Math.max(0, viewportHeight - topInset - bottomInset - 2 * margin);
}

/**
 * Widest viewport that gets the bottom action sheet (#1714): the phone layout,
 * one below Tailwind's `md` — the same breakpoint the mobile tab bar uses.
 */
export const MENU_SHEET_MAX_WIDTH = 767;

export type MenuPresentation = 'popover' | 'sheet';

/**
 * How a menu presents itself (#1714). On a phone it is a **bottom action
 * sheet**: it rises from the thumb's edge, so every item is reachable by
 * construction wherever the trigger sat. Wider viewports (tablet, desktop) and
 * the TV keep the anchored popover — a pointer reaches anywhere, and the TV's
 * D-pad focus contract is built on it. docs/design-patterns.md "Reachable
 * menus".
 */
export function menuPresentation(viewportWidth: number, tv: boolean): MenuPresentation {
  return !tv && viewportWidth <= MENU_SHEET_MAX_WIDTH ? 'sheet' : 'popover';
}

/** Where a bottom sheet sits: on the bottom chrome, never taller than the band above it. */
export interface MenuSheetLayout {
  /** Distance from the viewport bottom: the top of the visible bottom chrome, or 0. */
  bottom: number;
  maxHeight: number;
}

export function menuSheetLayout(
  viewportHeight: number,
  topInset = 0,
  bottomInset = 0,
  margin = 8,
): MenuSheetLayout {
  return {
    bottom: bottomInset,
    maxHeight: Math.max(0, viewportHeight - topInset - bottomInset - margin),
  };
}

/** A trigger element's viewport rect (the subset of DOMRect we need). */
export interface TriggerRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Position a dropdown panel anchored to a trigger button, then clamp it fully
 * into the viewport. This is the reusable fix for filter/context menus that used
 * a bare `absolute right-0`/`left-0` and spilled off-screen on narrow viewports
 * (the panel could be wider than the space to the trigger's right).
 *
 * - `align: 'end'` right-aligns the panel under the trigger (default, matches the
 *   prior `right-0` intent); `'start'` left-aligns it.
 * - Opens downward; **flips above** the trigger when there isn't room below but
 *   there is above.
 * - Always finishes by clamping with `clampMenuPosition`, so even a panel wider
 *   than the viewport is pinned to the edge margin instead of overflowing.
 * - `bottomInset` reserves fixed bottom chrome (mini-player + tab bar) height:
 *   it shrinks the room-below calc (so a low trigger flips up sooner) and the
 *   bottom clamp (so the panel never lands under the player/tab bar).
 * - `topInset` does the same at the top (status bar / notch + sticky header):
 *   the room above shrinks by it and the top clamp floors at it.
 */
export function computeMenuPosition(
  trigger: TriggerRect,
  panelWidth: number,
  panelHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  align: 'start' | 'end' = 'end',
  gap = 4,
  margin = 8,
  bottomInset = 0,
  topInset = 0,
): Point {
  const x = align === 'end' ? trigger.right - panelWidth : trigger.left;

  const below = trigger.bottom + gap;
  const above = trigger.top - gap - panelHeight;
  // Usable bottom excludes the fixed chrome, so a panel that would only fit by
  // overlapping the player/tab bar counts as "no room below" and flips up.
  const roomBelow = viewportHeight - bottomInset - below;
  // Flip up only when below can't fit the panel AND above has more room.
  const flipUp = roomBelow < panelHeight && trigger.top - gap - topInset > roomBelow;
  const y = flipUp ? above : below;

  return clampMenuPosition(
    { x, y },
    viewportWidth,
    viewportHeight,
    panelWidth,
    panelHeight,
    margin,
    bottomInset,
    topInset,
  );
}
