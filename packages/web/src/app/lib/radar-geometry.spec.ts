import { describe, expect, it } from 'vitest';
import { axisAngle, radarAxes, polygonPoints, ringPoints, truncateLabel } from './radar-geometry';

const CENTER = { cx: 100, cy: 100, radius: 50 };

describe('axisAngle', () => {
  it('starts at 12 o’clock and advances clockwise', () => {
    expect(axisAngle(0, 4)).toBeCloseTo(-Math.PI / 2);
    expect(axisAngle(1, 4)).toBeCloseTo(0);
    expect(axisAngle(2, 4)).toBeCloseTo(Math.PI / 2);
  });
});

describe('radarAxes', () => {
  it('places a full-value axis on the ring, straight up for the first spoke', () => {
    const [a] = radarAxes([{ label: 'Cumbia', value: 1 }], CENTER);
    expect(a.x).toBeCloseTo(100);
    expect(a.y).toBeCloseTo(50);
  });

  it('scales the radius linearly with the value', () => {
    const [half] = radarAxes([{ label: 'x', value: 0.5 }], CENTER);
    // Half the value sits half way along the spoke (100 - 50*0.5).
    expect(half.y).toBeCloseTo(75);
  });

  it('collapses a zero value onto the centre', () => {
    const [zero] = radarAxes([{ label: 'x', value: 0 }], CENTER);
    expect(zero.x).toBeCloseTo(100);
    expect(zero.y).toBeCloseTo(100);
  });

  it('clamps out-of-range values so nothing escapes the ring', () => {
    const [over, under] = radarAxes(
      [
        { label: 'over', value: 4 },
        { label: 'under', value: -2 },
      ],
      CENTER,
    );
    expect(over.value).toBe(1);
    expect(under.value).toBe(0);
  });

  it('always puts the spoke end on the ring regardless of value', () => {
    const axes = radarAxes(
      [
        { label: 'a', value: 0 },
        { label: 'b', value: 0.3 },
      ],
      CENTER,
    );
    for (const a of axes) {
      const d = Math.hypot(a.outer.x - CENTER.cx, a.outer.y - CENTER.cy);
      expect(d).toBeCloseTo(CENTER.radius);
    }
  });

  it('anchors labels away from the plot so they do not overhang it', () => {
    const axes = radarAxes(
      [
        { label: 'top', value: 1 },
        { label: 'right', value: 1 },
        { label: 'bottom', value: 1 },
        { label: 'left', value: 1 },
      ],
      CENTER,
    );
    expect(axes[0].anchor).toBe('middle'); // straight up
    expect(axes[1].anchor).toBe('start'); // right half
    expect(axes[2].anchor).toBe('middle'); // straight down
    expect(axes[3].anchor).toBe('end'); // left half
  });

  it('pushes label anchors outside the ring', () => {
    const [a] = radarAxes([{ label: 'x', value: 1 }], { ...CENTER, labelGap: 10 });
    expect(Math.hypot(a.labelAt.x - CENTER.cx, a.labelAt.y - CENTER.cy)).toBeCloseTo(60);
  });
});

describe('polygonPoints', () => {
  it('emits one rounded coordinate pair per axis', () => {
    const pts = polygonPoints(
      radarAxes(
        [
          { label: 'a', value: 1 },
          { label: 'b', value: 1 },
          { label: 'c', value: 1 },
        ],
        CENTER,
      ),
    );
    expect(pts.split(' ')).toHaveLength(3);
    expect(pts).not.toMatch(/\d\.\d{3}/); // coordinates stay short in the DOM
  });
});

describe('ringPoints', () => {
  it('draws a polygonal ring matching the spoke count, not a circle', () => {
    expect(ringPoints(5, 1, CENTER).split(' ')).toHaveLength(5);
  });

  it('scales the ring by its fraction', () => {
    const [x, y] = ringPoints(4, 0.5, CENTER).split(' ')[0].split(',').map(Number);
    expect(x).toBeCloseTo(100);
    expect(y).toBeCloseTo(75);
  });
});

describe('truncateLabel', () => {
  it('leaves a short label alone', () => {
    expect(truncateLabel('Cumbia')).toBe('Cumbia');
  });

  it('shortens a real long-form genre so it cannot overhang the chart', () => {
    // Discogs' top-level vocab; SVG <text> neither wraps nor clips.
    const short = truncateLabel('Folk, World, & Country');
    expect(short.length).toBeLessThanOrEqual(14);
    expect(short.endsWith('\u2026')).toBe(true);
  });

  it('does not leave a dangling space before the ellipsis', () => {
    expect(truncateLabel('Alternative Rock Music')).not.toMatch(/ \u2026$/);
  });

  it('respects a caller-supplied maximum', () => {
    expect(truncateLabel('Electronica', 6)).toBe('Elect\u2026');
  });
});
