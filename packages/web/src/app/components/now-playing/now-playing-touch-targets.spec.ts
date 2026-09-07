import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Issue #993: the queue-resize notch was ~20px of target around a 4px pill —
 * under the 44px touch floor, on the least forgiving interaction there is (a
 * drag, not a tap). Tailwind's `py-N` is N*4px per side, so the target height
 * is `pill + 2 * padding`.
 *
 * Asserted on the class string because jsdom cannot measure layout, and the
 * regression is precisely a number in that string.
 */
const TEMPLATE = join(import.meta.dirname, 'now-playing.component.html');
const PILL_PX = 4; // h-1
const TOUCH_FLOOR_PX = 44;

describe('now-playing queue-resize handle', () => {
  const html = readFileSync(TEMPLATE, 'utf8');
  const handle = html.split('\n').find((l) => l.includes('cursor-ns-resize'));

  it('still exists as a resize affordance', () => {
    expect(handle).toBeDefined();
  });

  it('clears the 44px touch target', () => {
    const py = Number(/\bpy-(\d+)\b/.exec(handle!)?.[1] ?? 0);
    expect(PILL_PX + py * 4 * 2).toBeGreaterThanOrEqual(TOUCH_FLOOR_PX);
  });

  it('pads symmetrically, so it reads as centred in its gap', () => {
    // An asymmetric pt-/pb- pair is what made it sit closer to the tabs.
    expect(/\bpt-\d+\b/.test(handle!)).toBe(false);
    expect(/\bpb-\d+\b/.test(handle!)).toBe(false);
  });
});
