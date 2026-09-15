import { test, expect } from '@playwright/test';

/**
 * Settings → About (issue #453, docs/licensing.md). The licence statement and
 * the AGPL §13 source offer are unit-tested; what only a real browser shows is
 * that the route resolves, the card renders, and the version the running server
 * actually shipped is on it.
 *
 * The card's collapsed-by-default convention is asserted by
 * settings-consistency.spec.ts, which now carries `/settings/about` too.
 */
test('the About card renders and shows the running version', async ({ page }) => {
  await page.goto('/settings/about');
  await expect(page.getByTestId('about-settings')).toBeVisible();

  const toggle = page.getByTestId('settings-group-toggle').first();
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();

  await expect(page.getByTestId('about-version')).toHaveText(/^v\d+\.\d+\.\d+/);
  await expect(page.getByTestId('about-licence')).toContainText('AGPL-3.0-only');
  await expect(page.getByTestId('about-source-link')).toHaveAttribute(
    'href',
    /github\.com\/kevinch3\/NicotinD/,
  );
});
