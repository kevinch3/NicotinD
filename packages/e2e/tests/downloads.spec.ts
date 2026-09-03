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
  test('the legacy /downloads path redirects onto the Activity tab', async ({ page }) => {
    await page.goto('/downloads');

    await expect(page).toHaveURL(/\/get(\?|$)/);
    await expect(page).toHaveURL(/tab=activity/);
    // Neither the empty-state text NOR `downloads-active` is a stable anchor:
    // the feed section only renders when the feed is non-empty, so both depend
    // on what earlier specs left behind. What is always true of this pane is
    // that the Activity tab is current and the Add pane is gone.
    await expect(page.getByTestId('get-tab-downloads')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('search-input')).toHaveCount(0);
  });

  test('switching tabs swaps the pane and is linkable', async ({ page }) => {
    await page.goto('/get');
    // Default tab is Add.
    await expect(page.getByTestId('search-input')).toBeVisible();

    await page.getByTestId('get-tab-downloads').click();
    await expect(page.getByTestId('search-input')).toHaveCount(0);
    await expect(page).toHaveURL(/tab=activity/);

    // A reload of that URL comes straight back to the same pane.
    await page.reload();
    await expect(page.getByTestId('get-tab-downloads')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('search-input')).toHaveCount(0);

    await page.getByTestId('get-tab-find').click();
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page).toHaveURL(/tab=add/);
  });

  // The tabs were renamed in #664, but `?tab=find|downloads` are in bookmarks
  // and shared links. They still resolve — a renamed tab is not a reason to
  // break a URL — even though the app now *emits* the new values.
  test('the pre-rename ?tab= values still resolve', async ({ page }) => {
    await page.goto('/get?tab=downloads');
    await expect(page.getByTestId('get-tab-downloads')).toHaveAttribute('aria-current', 'page');

    await page.goto('/get?tab=find');
    await expect(page.getByTestId('search-input')).toBeVisible();
  });
});
