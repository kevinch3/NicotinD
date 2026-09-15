import { test, expect, type Page } from '@playwright/test';
import { clearGroupState } from '../helpers';

/**
 * Cross-view consistency spec (Task 5, settings-cards unification). Tasks 1-4
 * migrated `/settings`, `/admin`, `/settings/plugins`, `/settings/devices`, and
 * `/settings/agent-tokens` onto one shared `app-settings-group` component. This
 * is the CI-safe correctness check that the migration actually produced ONE
 * visual identity rather than five copies that merely share a class list:
 * every route's first group card + its header title must resolve to identical
 * computed styles, and every route must render fully collapsed on first load
 * (precedent: `mobile-ux.spec.ts`'s `page.evaluate`/`getComputedStyle` checks).
 *
 * Deliberately no screenshots/pixel comparison and no timing-sensitive waits
 * beyond the normal `expect(...).toBeVisible()` load gate — computed style
 * reads are deterministic once the element is in the DOM.
 */
const ROUTES = [
  '/settings',
  '/admin',
  '/settings/plugins',
  '/settings/devices',
  '/settings/agent-tokens',
  '/settings/about',
];

interface StyleTuple {
  card: {
    borderRadius: string;
    borderColor: string;
    backgroundColor: string;
  };
  title: {
    fontSize: string;
    fontWeight: string;
    color: string;
  };
}

/** goto + collapse-state reset + the load gate every reading below needs. */
async function openRoute(page: Page, route: string): Promise<void> {
  await page.goto(route);
  await clearGroupState(page);
  await page.reload();
  await expect(page.locator('[data-group-id]').first()).toBeVisible();
}

async function readStyleTuple(page: Page): Promise<StyleTuple> {
  return page.evaluate(() => {
    const card = document.querySelector('[data-group-id]') as HTMLElement | null;
    if (!card) throw new Error('expected at least one [data-group-id] card on the page');
    const toggle = card.querySelector(
      '[data-testid="settings-group-toggle"]',
    ) as HTMLElement | null;
    if (!toggle) throw new Error('expected the first card to have a settings-group-toggle');
    const title = toggle.querySelector('h2') as HTMLElement | null;
    if (!title) throw new Error('expected the toggle to contain a header title (h2)');

    const cardStyle = getComputedStyle(card);
    const titleStyle = getComputedStyle(title);
    return {
      card: {
        borderRadius: cardStyle.borderRadius,
        borderColor: cardStyle.borderColor,
        backgroundColor: cardStyle.backgroundColor,
      },
      title: {
        fontSize: titleStyle.fontSize,
        fontWeight: titleStyle.fontWeight,
        color: titleStyle.color,
      },
    };
  });
}

/** Issue #384: the settings family + admin share ONE page-shell gutter scale.
 * Issue #420 merged the settings family's 2xl tier into admin's 3xl — one
 * width everywhere, so the content column no longer jumps between routes. */
const WRAPPER_MAX_WIDTH: Record<string, string> = {
  '/settings': '768px',
  '/settings/plugins': '768px',
  '/settings/devices': '768px',
  '/settings/agent-tokens': '768px',
  '/settings/about': '768px',
  '/admin': '768px',
};

test.describe('settings cards — cross-view consistency', () => {
  // The one documented default-open exception (issue #379): Devices' paired
  // list is that page's primary content (the visit reason is revoking a
  // device), so it renders expanded while every sibling stays collapsed.
  const DEFAULT_OPEN: Record<string, number> = { '/settings/devices': 1 };

  // One test per route, for the same reason as the tuple comparison below: this
  // ran as one loop over every route, and `openRoute` costs two SPA loads each
  // (goto + clearGroupState + reload). At five routes that was 10 loads inside a
  // single 30s budget and already the next candidate flagged by #1116's split;
  // #453 added a sixth and it started timing out on CI's shard 4, naming no
  // route. Splitting keeps the navigation count identical and makes the failure
  // say which page regressed.
  for (const route of ROUTES) {
    test(`${route} renders collapsed on first load (minus documented exceptions)`, async ({
      page,
    }) => {
      await openRoute(page, route);
      await expect(page.getByTestId('settings-group-body')).toHaveCount(DEFAULT_OPEN[route] ?? 0);
    });
  }

  // One test per route, not one loop over five (#1116): the loop spent 10 SPA
  // navigations inside a single 30s budget and, when it timed out, named no
  // route. The reference tuple is captured from ROUTES[0] by whichever of these
  // runs first and reused, so the total navigation count is unchanged.
  const [referenceRoute, ...comparedRoutes] = ROUTES;
  let reference: StyleTuple | undefined;

  async function referenceTuple(page: Page): Promise<StyleTuple> {
    if (!reference) {
      await openRoute(page, referenceRoute);
      reference = await readStyleTuple(page);
    }
    return reference;
  }

  for (const route of comparedRoutes) {
    test(`${route}'s group card + title match ${referenceRoute}`, async ({ page }) => {
      const expected = await referenceTuple(page);
      await openRoute(page, route);
      expect(
        await readStyleTuple(page),
        `${route} card/title styles should match ${referenceRoute}`,
      ).toEqual(expected);
    });
  }

  test('every settings-family route shares the page-shell gutter scale', async ({ page }) => {
    const readings: Array<{ route: string; maxWidth: string; pad: string }> = [];
    for (const route of ROUTES) {
      await page.goto(route);
      // /admin renders a transient `loading()` page-shell before swapping to the
      // loaded one; waiting on the stable group card (as the tests above do)
      // avoids reading computed styles off a node Angular is about to detach.
      await expect(page.locator('[data-group-id]').first()).toBeVisible();
      const shell = page.locator('.page-shell').first();
      await expect(shell).toBeVisible();
      readings.push(
        await shell.evaluate((el, r) => {
          const s = getComputedStyle(el);
          return {
            route: r,
            maxWidth: s.maxWidth,
            pad: `${s.paddingLeft}/${s.paddingRight}/${s.paddingTop}/${s.paddingBottom}`,
          };
        }, route),
      );
    }
    for (const r of readings) {
      expect.soft(r.maxWidth, r.route).toBe(WRAPPER_MAX_WIDTH[r.route]);
      expect.soft(r.pad, r.route).toBe(readings[0].pad);
    }
  });
});
