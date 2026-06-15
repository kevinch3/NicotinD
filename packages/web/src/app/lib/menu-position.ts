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
