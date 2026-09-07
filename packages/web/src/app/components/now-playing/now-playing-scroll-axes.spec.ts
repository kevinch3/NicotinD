import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Issue #992: the queue panel scrolled *sideways*, dragging the whole Now
 * Playing sheet with it, and the title's `truncate` looked correct the whole
 * time — because it never got the chance to apply.
 *
 * The cause is a CSS rule that is easy to forget: when one overflow axis is
 * `auto`/`scroll` and the other is `visible`, the visible one **computes to
 * `auto`**. So `overflow-y-auto` alone silently opts an element into horizontal
 * scrolling, and any single pixel of intrinsic overflow becomes a scrollbar
 * instead of being clipped.
 *
 * The lyrics and karaoke panels already paired the axes; the queue panel was
 * the only one of the four that did not. That is a class of defect, not a
 * one-off, so the rule is pinned across every Now Playing template rather than
 * the single line that was wrong.
 */
const NOW_PLAYING_DIR = join(import.meta.dirname);

function templatesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...templatesUnder(full));
    else if (entry.endsWith('.component.html')) out.push(full);
  }
  return out;
}

/** Class attributes on elements that scroll vertically. */
function verticalScrollers(html: string): string[] {
  return (html.match(/class="[^"]*overflow-y-auto[^"]*"/g) ?? []).map((m) => m.slice(7, -1));
}

describe('Now Playing scroll containers constrain both axes', () => {
  const templates = templatesUnder(NOW_PLAYING_DIR);

  it('finds the templates it is meant to guard', () => {
    // A vacuous pass is the failure mode of a test shaped like this one.
    expect(templates.length).toBeGreaterThan(3);
    expect(templates.some((t) => t.includes('queue-panel'))).toBe(true);
  });

  it('never leaves overflow-x to default to auto', () => {
    const offenders: string[] = [];
    for (const file of templates) {
      for (const classes of verticalScrollers(readFileSync(file, 'utf8'))) {
        const constrained =
          classes.includes('overflow-x-hidden') ||
          classes.includes('overflow-x-auto') ||
          classes.includes('overflow-hidden');
        if (!constrained) offenders.push(`${file.split('/').pop()}: ${classes}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
