/**
 * Pure geometry for the genre radar (issue #222). Kept DI-free so the maths is
 * unit-tested without a DOM — the component only maps these to SVG attributes.
 * See docs/genre-radar.md.
 */

export interface RadarPoint {
  x: number;
  y: number;
}

export interface RadarAxis extends RadarPoint {
  label: string;
  /** 0..1 — where the value sits along the spoke. */
  value: number;
  /** Outer end of the spoke (the ring), for drawing the axis line. */
  outer: RadarPoint;
  /** Label anchor, pushed past the ring so text clears the polygon. */
  labelAt: RadarPoint;
  /** SVG text-anchor that keeps the label from overlapping the chart. */
  anchor: 'start' | 'middle' | 'end';
}

/** Start at 12 o'clock and go clockwise — the orientation people expect. */
const START_ANGLE = -Math.PI / 2;

export function axisAngle(index: number, count: number): number {
  return START_ANGLE + (index / count) * Math.PI * 2;
}

function at(cx: number, cy: number, angle: number, radius: number): RadarPoint {
  return { x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
}

/**
 * `anchor` is chosen from the spoke's horizontal direction so labels on the left
 * half end-align and those on the right start-align; near-vertical spokes centre.
 * Without this every label is centred on its spoke and the left/right ones
 * overhang into the polygon.
 */
function anchorFor(angle: number): RadarAxis['anchor'] {
  const cos = Math.cos(angle);
  if (Math.abs(cos) < 0.2) return 'middle';
  return cos > 0 ? 'start' : 'end';
}

/**
 * Map 0..1 values onto spokes of a radar centred at (cx, cy).
 *
 * Radius is **linear in the value**, not area-proportional. A radar already
 * exaggerates differences because the enclosed area grows with the square of
 * the radius; compensating for that would make the shape unreadable in the
 * other direction. The paired value table is what carries exact magnitudes —
 * the polygon is for shape, not measurement.
 */
export function radarAxes(
  values: { label: string; value: number }[],
  opts: { cx: number; cy: number; radius: number; labelGap?: number },
): RadarAxis[] {
  const { cx, cy, radius } = opts;
  const labelGap = opts.labelGap ?? 14;
  const count = values.length;
  return values.map((v, i) => {
    const angle = axisAngle(i, count);
    const clamped = Math.min(1, Math.max(0, v.value));
    return {
      label: v.label,
      value: clamped,
      ...at(cx, cy, angle, radius * clamped),
      outer: at(cx, cy, angle, radius),
      labelAt: at(cx, cy, angle, radius + labelGap),
      anchor: anchorFor(angle),
    };
  });
}

/** `points` attribute for the value polygon. */
export function polygonPoints(axes: RadarAxis[]): string {
  return axes.map((a) => `${round(a.x)},${round(a.y)}`).join(' ');
}

/**
 * One background ring at `fraction` of the radius. Rings are polygons, not
 * circles, so the grid matches the polygon's own geometry — a circular grid on
 * a polygonal plot reads as though values between spokes exist, and they don't.
 */
export function ringPoints(
  count: number,
  fraction: number,
  opts: { cx: number; cy: number; radius: number },
): string {
  const r = opts.radius * fraction;
  return Array.from({ length: count }, (_, i) => {
    const p = at(opts.cx, opts.cy, axisAngle(i, count), r);
    return `${round(p.x)},${round(p.y)}`;
  }).join(' ');
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Shorten an axis label so it can't overhang the chart box. Real genre names go
 * well past the space a spoke has — Discogs' top-level vocab includes
 * "Folk, World, & Country" — and an SVG `<text>` neither wraps nor clips, so an
 * untruncated label runs into whatever sits beside the chart. The full name
 * stays available via the mark's tooltip.
 */
export function truncateLabel(label: string, max = 14): string {
  if (label.length <= max) return label;
  return `${label.slice(0, max - 1).trimEnd()}…`;
}
