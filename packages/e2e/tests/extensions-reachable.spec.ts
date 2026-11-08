import { test, expect, expandGroup } from '../helpers';

/**
 * #1734: in a self-hoster trial the Extensions page (where every acquisition
 * source is enabled) was found only by reading docs/plugins.md. Its one link
 * sat inside the collapsed "Account & Devices" settings group, /extensions
 * redirected home, and the Add page's "No acquisition sources enabled" was
 * plain text. The setup project signs in as the admin.
 */
test.describe('the Extensions page is reachable', () => {
  test('from Home, by clicking only: Add → "No acquisition sources enabled"', async ({ page }) => {
    await page.goto('/');
    await page.locator('a[href="/get"]:visible').first().click();
    await expect(page.getByTestId('source-status')).toContainText('No acquisition sources enabled');

    await page.getByTestId('source-status-extensions-link').click();
    await expect(page).toHaveURL(/\/settings\/plugins$/);
    await expect(page.locator('[data-group-id="plugins-acquisition"]')).toBeVisible();
  });

  test('from the Admin acquisition panel', async ({ page }) => {
    await page.goto('/admin');
    await expandGroup(page, 'acquisition-automation'); // a click, like a user's
    await page.getByTestId('acquisition-extensions-link').click();
    await expect(page).toHaveURL(/\/settings\/plugins$/);
  });

  test('/extensions is the Extensions page, not Home', async ({ page }) => {
    await page.goto('/extensions');
    await expect(page).toHaveURL(/\/settings\/plugins$/);
  });
});
