/**
 * Infers how many items form one visual row of a CSS grid by counting
 * consecutive elements (from the first) that share the first element's
 * `offsetTop` — no `grid-template-columns` parsing needed, so it works
 * across any responsive Tailwind `grid-cols-*` breakpoint. Pure/DOM-only so
 * it's unit-testable without a directive fixture (jsdom, this project's test
 * environment, doesn't compute real layout, so callers must stub
 * `offsetTop` — see tv-nav-grid.spec.ts).
 */
export function inferColumnsPerRow(elements: HTMLElement[]): number {
  if (elements.length === 0) return 1;
  const firstTop = elements[0]!.offsetTop;
  let count = 0;
  for (const el of elements) {
    if (el.offsetTop !== firstTop) break;
    count++;
  }
  return Math.max(count, 1);
}

/**
 * Column count for a CSS Grid container, read from the resolved
 * `grid-template-columns` (a space-separated list of track sizes, e.g.
 * `"80px 80px 80px"` for `grid-cols-3`) rather than `inferColumnsPerRow`'s
 * offsetTop inference — this reads the *container's* own responsive
 * Tailwind class directly, so it's known even before any child card has
 * rendered/laid out (issue #359's role="row" wrappers need the count up
 * front, to chunk the flat item array before rendering rows — a chicken/egg
 * problem `inferColumnsPerRow` can't solve since it needs already-rendered
 * item elements). Falls back to 1 (single column, degrades to one item per
 * row rather than crashing) if the container isn't a grid or isn't laid out
 * yet (e.g. `display: none`, detached).
 */
export function gridColumnCount(container: HTMLElement): number {
  const value = getComputedStyle(container).gridTemplateColumns;
  if (!value || value === 'none') return 1;
  const tracks = value.trim().split(/\s+/).filter(Boolean);
  return Math.max(tracks.length, 1);
}

/** Splits `items` into consecutive chunks of `size` (the last chunk may be
 *  shorter) — used to group a flat item array into `role="row"` slices for
 *  ARIA grid conformance (issue #359). `size < 1` degenerates to one item
 *  per chunk rather than looping forever/throwing. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(Math.floor(size), 1);
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += step) {
    rows.push(items.slice(i, i + step));
  }
  return rows;
}
