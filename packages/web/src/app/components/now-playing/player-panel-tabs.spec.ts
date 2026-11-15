import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYER_PANEL_TABS } from './player-panel-tabs';

/**
 * The tab contract's rules 1 and 2 (#1681, docs/player-panel.md §4), swept
 * over every registered tab's body template. A tab that obeys them needs no
 * gesture code: the sheet's pull finds its scroller and skips its rows.
 */
const BODY_TEMPLATES: Record<string, string> = {
  queue: 'now-playing-queue-panel/now-playing-queue-panel.component.html',
  lyrics: 'now-playing-lyrics-panel/now-playing-lyrics-panel.component.html',
};

function parse(file: string): Document {
  const html = readFileSync(join(__dirname, file), 'utf8');
  return new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html');
}

describe('player panel tab contract (#1681)', () => {
  it('sweeps every registered tab', () => {
    // Asserts its own denominator: a new tab must add its body template here.
    expect(Object.keys(BODY_TEMPLATES).sort()).toEqual(
      DEFAULT_PLAYER_PANEL_TABS.map((t) => t.id).sort(),
    );
  });

  describe.each(Object.entries(BODY_TEMPLATES))('the %s tab', (id, file) => {
    const doc = parse(file);
    const classOf = (el: Element) => el.getAttribute('class') ?? '';

    it('rule 1: its vertical scroller clips the other axis', () => {
      const scrollers = [...doc.querySelectorAll('[class]')].filter((el) =>
        /(^|\s)overflow-y-auto(\s|$)/.test(classOf(el)),
      );
      expect(scrollers.length, 'a body scrolls its own list').toBeGreaterThan(0);
      for (const el of scrollers) {
        expect(classOf(el), 'overflow-y-auto alone computes overflow-x to auto').toMatch(
          /(^|\s)overflow-x-hidden(\s|$)/,
        );
      }
    });

    it('rule 2: anything with a gesture of its own carries data-np-no-swipe', () => {
      const gestured = [...doc.querySelectorAll('*')].filter((el) =>
        [...el.attributes].some((a) =>
          ['(pointerdown)', 'draggable', '[attr.draggable]', '(dragstart)'].includes(a.name),
        ),
      );
      // The queue's reorderable rows are the case the rule exists for.
      if (id === 'queue') expect(gestured.length).toBeGreaterThan(0);
      for (const el of gestured) {
        expect(el.closest('[data-np-no-swipe]'), el.outerHTML.slice(0, 120)).not.toBeNull();
      }
    });
  });
});
