import { test, expect } from '@playwright/test';

/**
 * Phase 3 — the unified downloads feed. With acquisition default-off and slskd
 * unreachable in e2e there are no live transfers, so this guards that the
 * Active-feed page renders its empty state without a runtime/template error.
 *
 * The page is now Active-feed-only: "Recently Added" moved to the Library Songs
 * tab and "Saved Offline" browsing moved to that tab's offline variant, so there
 * are no longer any downloads tabs to switch between.
 */
test.describe('downloads', () => {
  test('renders the unified feed empty state (no crash) with no tabs', async ({ page }) => {
    await page.goto('/downloads');

    await expect(page.getByText('No active downloads.')).toBeVisible();

    // The former tab bar is gone.
    await expect(page.getByTestId('downloads-tab-recent')).toHaveCount(0);
    await expect(page.getByTestId('downloads-tab-offline')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Scan library' })).toBeVisible();
  });
});
