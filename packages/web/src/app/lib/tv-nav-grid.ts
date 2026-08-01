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
