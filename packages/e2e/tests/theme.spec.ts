import { test, expect } from '@playwright/test';

test.describe('e-ink theme', () => {
  // Regression guard for the e-paper legibility fix: stroked icons "blended"
  // into the page because a 2-user-unit stroke flattens to a faint line on
  // e-ink. styles.css bumps `[data-theme=eink] svg { stroke-width: 3 }`.
  test('thickens icon strokes versus the default theme', async ({ page }) => {
    await page.goto('/library');
    await page.locator('svg').first().waitFor();

    const strokeFor = (theme: string) =>
      page.evaluate((t) => {
        document.documentElement.setAttribute('data-theme', t);
        const svg = document.querySelector('svg');
        return svg ? parseFloat(getComputedStyle(svg).strokeWidth) : NaN;
      }, theme);

    const def = await strokeFor('midnight');
    const eink = await strokeFor('eink');

    expect(eink).toBeGreaterThanOrEqual(3);
    expect(eink).toBeGreaterThan(def);
  });
});
