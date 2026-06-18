import { test, expect } from '@playwright/test';

/**
 * Phase 3 — the unified downloads feed. With acquisition default-off and slskd
 * unreachable in e2e there are no live transfers, so this guards that the
 * reworked Active-tab feed renders its empty state without a runtime/template
 * error and that tab switching works.
 */
test.describe('downloads', () => {
  test('Active tab renders the unified feed empty state and tabs switch', async ({ page }) => {
    await page.goto('/downloads');

    // Active tab is default and shows the unified empty state (no runtime crash).
    await expect(page.getByText('No active downloads.')).toBeVisible();

    // Switching to Recently Added works and the page stays intact.
    await page.getByRole('button', { name: 'Recently Added' }).click();
    await expect(page.getByRole('button', { name: 'Saved Offline' })).toBeVisible();
  });

  // The live-screens `downloads-acquire` flow targets the tabs by testid; guard
  // that those stable hooks exist and drive tab switching.
  test('tab buttons expose stable testids and switch', async ({ page }) => {
    await page.goto('/downloads');
    await expect(page.getByTestId('downloads-tab-active')).toBeVisible();
    await expect(page.getByTestId('downloads-tab-offline')).toBeVisible();
    await expect(page.getByTestId('downloads-tab-recent')).toBeVisible();

    await page.getByTestId('downloads-tab-recent').click();
    await expect(page.getByTestId('recent-heading')).toBeVisible();
  });
});
