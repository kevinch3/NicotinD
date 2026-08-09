import { test, expect } from '@playwright/test';

/**
 * Phase 3 — the unified downloads feed, now the Downloads tab of the merged
 * /get workspace. With acquisition default-off and slskd unreachable in e2e
 * there are no live transfers, so this guards that the Active-feed pane renders
 * its empty state without a runtime/template error.
 *
 * The pane is Active-feed-only: "Recently Added" moved to the Library Songs tab
 * and "Saved Offline" browsing moved to that tab's offline variant.
 */
test.describe('downloads', () => {
  test('the legacy /downloads path redirects onto the Downloads tab', async ({ page }) => {
    await page.goto('/downloads');

    await expect(page).toHaveURL(/\/get(\?|$)/);
    await expect(page).toHaveURL(/tab=downloads/);
    await expect(page.getByText('No active downloads.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Scan library' })).toBeVisible();
  });

  test('switching tabs swaps the pane and is linkable', async ({ page }) => {
    await page.goto('/get');
    // Default tab is Find.
    await expect(page.getByTestId('search-input')).toBeVisible();

    await page.getByTestId('get-tab-downloads').click();
    await expect(page.getByText('No active downloads.')).toBeVisible();
    await expect(page.getByTestId('search-input')).toHaveCount(0);
    await expect(page).toHaveURL(/tab=downloads/);

    // A reload of that URL comes straight back to the same pane.
    await page.reload();
    await expect(page.getByText('No active downloads.')).toBeVisible();

    await page.getByTestId('get-tab-find').click();
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page).toHaveURL(/tab=find/);
  });
});
