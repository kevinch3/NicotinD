import type { Page } from '@playwright/test';
import { test, expect } from '../helpers';

/**
 * #1739: on a fresh install with an empty music folder, Home was a field of
 * mood radios that played nothing and Library said only "No songs found.",
 * with no word on where music goes and the scan three panels deep in Admin.
 *
 * The suite's server has a seeded library, so the empty one is simulated at the
 * API: every song read answers with nothing. The scan request is intercepted
 * too, so the test asserts the button reaches the server without starting a
 * real scan of the shared fixture library. The setup project signs in as admin.
 */
async function emptyLibrary(page: Page): Promise<{ scans: () => number }> {
  let scans = 0;
  await page.route('**/api/library/songs?**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/library/random?**', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/system/scan', (route) => {
    scans++;
    return route.fulfill({ json: { ok: true, message: 'Library scan started' } });
  });
  return { scans: () => scans };
}

test.describe('empty-library first run (#1739)', () => {
  test('Home shows where music goes and a working Scan, not radio tiles', async ({ page }) => {
    const { scans } = await emptyLibrary(page);
    await page.goto('/');

    const empty = page.getByTestId('empty-library');
    await expect(empty).toBeVisible();
    await expect(page.getByTestId('empty-library-path')).not.toBeEmpty();
    await expect(page.getByTestId('empty-library-add')).toHaveAttribute('href', '/get');
    await expect(page.getByTestId('mosaic-tile-link')).toHaveCount(0);

    await page.getByTestId('empty-library-scan').click();
    await expect(page.getByTestId('empty-library-scan-status')).toBeVisible();
    expect(scans()).toBe(1);
  });

  test('Library shows the same state instead of "No songs found."', async ({ page }) => {
    const { scans } = await emptyLibrary(page);
    await page.goto('/library');
    // Songs is the default tab, but the suite's shared session may have left
    // another one remembered.
    await page.getByRole('button', { name: 'Songs', exact: true }).click();

    await expect(page.getByTestId('empty-library')).toBeVisible();
    await expect(page.getByText('No songs found.')).toHaveCount(0);

    await page.getByTestId('empty-library-scan').click();
    await expect(page.getByTestId('empty-library-scan-status')).toBeVisible();
    expect(scans()).toBe(1);
  });
});
