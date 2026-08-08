/**
 * The generic audit: on each route, is every focusable control actually
 * reachable by remote?
 *
 * The per-surface escape spec tests a bug we know about. This one finds the
 * next one. It computes the reachable closure of the focus graph and diffs it
 * against what the page declares focusable — an element carrying
 * `appTvNavItem`/`tabindex=0` that no key sequence can land on is unusable on a
 * TV, whatever it looks like.
 */
import { test, expect, goto, startPlayback } from '../tv/fixtures.js';
import type { Page } from '@playwright/test';

const DIRECTIONS = ['DOWN', 'UP', 'RIGHT', 'LEFT'] as const;
/** Guards against a cycle the identity rule fails to collapse. Hitting it fails. */
const MAX_PRESSES = 600;

/**
 * Identity is a stamped attribute, not a testid.
 *
 * why: the walk must be able to *resume* any state it reached, and derived ids
 * can't round-trip. A first cut keyed on `data-testid` with a tagName fallback
 * returned `a` for an unlabelled anchor, then failed to re-focus it (no element
 * has `data-testid="a"`), aborting the walk after one step and reporting almost
 * the whole page unreachable. A stamp is unique, survives re-focus, and works
 * for elements with no testid at all.
 */
const STAMP = 'tvwalk';

interface Declared {
  key: string;
  label: string;
}

/** Stamp every declared-focusable element and return {key,label} for each. */
async function stampDeclared(page: Page): Promise<Declared[]> {
  return page.evaluate((attr) => {
    const w = window as unknown as { __tvwalk?: number };
    w.__tvwalk ??= 0;
    const out: { key: string; label: string }[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('[appTvNavItem], [tabindex="0"]')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      // Off-screen (e.g. the closed Now Playing sheet) isn't a defect.
      if (r.bottom < 0 || r.top > window.innerHeight) continue;
      if (getComputedStyle(el).visibility === 'hidden') continue;
      el.dataset[attr] ??= String(++w.__tvwalk!);
      out.push({
        key: el.dataset[attr]!,
        label: el.dataset.testid ?? el.getAttribute('aria-label') ?? el.tagName.toLowerCase(),
      });
    }
    return out;
  }, STAMP);
}

/** Stamp whatever is focused now and return its key (null for body/none). */
async function stampFocused(page: Page): Promise<string | null> {
  return page.evaluate((attr) => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return null;
    const w = window as unknown as { __tvwalk?: number };
    w.__tvwalk ??= 0;
    el.dataset[attr] ??= String(++w.__tvwalk!);
    return el.dataset[attr]!;
  }, STAMP);
}

/**
 * Resume a focus state by stamp.
 *
 * Programmatic focus is legitimate here: it only restores a state the remote
 * demonstrably reached, so the closure computed is still a real D-pad closure.
 * Without it, every direction fires from wherever focus last drifted and the
 * walk degenerates into one path.
 */
async function focusStamp(page: Page, key: string): Promise<boolean> {
  return page.evaluate(
    ([attr, k]) => {
      const el = document.querySelector<HTMLElement>(`[data-${attr}="${k}"]`);
      if (!el) return false;
      el.focus();
      return document.activeElement === el;
    },
    [STAMP, key] as const,
  );
}

test.describe('D-pad reachability audit', () => {
  test.beforeEach(async ({ page }) => {
    await startPlayback(page);
  });

  for (const route of ['/', '/library', '/settings']) {
    test(`every focusable control on ${route} is reachable`, async ({ page, dpad }) => {
      await goto(page, route);
      await page.waitForTimeout(1500);

      const declared = await stampDeclared(page);

      // Seed from the body: DOWN is a viewer's first press.
      await dpad('DOWN');
      const start = await stampFocused(page);
      const seen = new Set<string>(start ? [start] : []);
      const frontier = start ? [start] : [];
      let presses = 0;

      while (frontier.length) {
        const from = frontier.shift()!;
        for (const dir of DIRECTIONS) {
          if (presses++ > MAX_PRESSES) {
            throw new Error(
              `[e2e:tv] reachability walk exceeded ${MAX_PRESSES} presses on ${route} — ` +
                'likely a focus cycle the stamp identity fails to collapse. ' +
                'Failing rather than silently reporting partial coverage.',
            );
          }
          if (!(await focusStamp(page, from))) break; // element went away (re-render)
          await dpad(dir);
          const id = await stampFocused(page);
          if (id && !seen.has(id)) {
            seen.add(id);
            frontier.push(id);
          }
        }
      }

      // The TV tree must contain NO native form controls at all. A remote has
      // no Tab, so any focusable <input>/<select>/<textarea> is a trap by
      // construction (issue #438) — that is why the seek bar could swallow all
      // four arrow keys with no way out. Asserted here rather than left as a
      // convention, because a convention loses to the next person adding a
      // <select> who has no reason to think about remotes.
      //
      // Note this is a separate check from the reachability diff below: a
      // native input carries neither appTvNavItem nor tabindex="0", so the walk
      // never sees it — which is exactly why the audit passed while #438 was
      // live.
      const natives = await page.locator('input, select, textarea, [contenteditable]').count();
      expect(natives, `${route} renders ${natives} native form control(s)`).toBe(0);

      const unreachable = declared.filter((d) => !seen.has(d.key)).map((d) => d.label);

      expect(
        unreachable,
        `unreachable by D-pad on ${route}: ${unreachable.join(', ')}\n` +
          `(reached ${seen.size} of ${declared.length} declared focusables)`,
      ).toEqual([]);
    });
  }
});
