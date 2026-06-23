export interface Point {
  x: number;
  y: number;
}

/**
 * Clamp a popup/menu's top-left so it stays fully within the viewport. A context
 * menu opened at a tap's raw coordinates otherwise overflows the right/bottom
 * edge on mobile (§G6). Keeps a small margin from every edge.
 */
export function clampMenuPosition(
  pos: Point,
  viewportWidth: number,
  viewportHeight: number,
  menuWidth = 200,
  menuHeight = 96,
  margin = 8,
): Point {
  const maxX = Math.max(margin, viewportWidth - menuWidth - margin);
  const maxY = Math.max(margin, viewportHeight - menuHeight - margin);
  return {
    x: Math.min(Math.max(margin, pos.x), maxX),
    y: Math.min(Math.max(margin, pos.y), maxY),
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
): Point {
  const x = align === 'end' ? trigger.right - panelWidth : trigger.left;

  const below = trigger.bottom + gap;
  const above = trigger.top - gap - panelHeight;
  const roomBelow = viewportHeight - below;
  // Flip up only when below can't fit the panel AND above has more room.
  const flipUp = roomBelow < panelHeight && trigger.top - gap > roomBelow;
  const y = flipUp ? above : below;

  return clampMenuPosition({ x, y }, viewportWidth, viewportHeight, panelWidth, panelHeight, margin);
}
