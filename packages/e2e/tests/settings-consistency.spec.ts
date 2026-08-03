import { test, expect, type Page } from '@playwright/test';

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

/** Every persisted group-open key is prefixed `nicotind-group-` (see
 * `lib/group-state.ts`) — cleared so a leftover expanded state from an earlier
 * spec/run can never make a route look "not collapsed by default". */
async function clearGroupState(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('nicotind-group-')) localStorage.removeItem(key);
    }
  });
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

test.describe('settings cards — cross-view consistency', () => {
  test('every route renders fully collapsed on first load', async ({ page }) => {
    for (const route of ROUTES) {
      await page.goto(route);
      await clearGroupState(page);
      await page.reload();
      await expect(page.locator('[data-group-id]').first()).toBeVisible();
      await expect(page.getByTestId('settings-group-body')).toHaveCount(0);
    }
  });

  test("every route's group card + title share identical computed styles", async ({ page }) => {
    const tuples: Record<string, StyleTuple> = {};

    for (const route of ROUTES) {
      await page.goto(route);
      await clearGroupState(page);
      await page.reload();
      await expect(page.locator('[data-group-id]').first()).toBeVisible();
      tuples[route] = await readStyleTuple(page);
    }

    const [firstRoute, ...restRoutes] = ROUTES;
    const expected = tuples[firstRoute];

    for (const route of restRoutes) {
      expect(tuples[route], `${route} card/title styles should match ${firstRoute}`).toEqual(
        expected,
      );
    }
  });
});
