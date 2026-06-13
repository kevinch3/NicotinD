import { test, expect } from '@playwright/test';

/**
 * The compliance-critical contract: acquisition UI only appears when a backing
 * plugin is enabled. yt-dlp is a consent-gated `resolve` plugin, default-off.
 */
test.describe('plugin capability gating', () => {
  const ytdlpCard = (page: import('@playwright/test').Page) =>
    page.locator('[data-testid="plugin-card"][data-plugin-id="ytdlp"]');

  test.afterEach(async ({ page }) => {
    // Leave yt-dlp disabled so the suite stays order-independent.
    await page.goto('/settings/plugins');
    const card = ytdlpCard(page);
    if ((await card.getByTestId('plugin-toggle').textContent())?.trim() === 'Disable') {
      await card.getByTestId('plugin-toggle').click();
      await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    }
  });

  test('enabling yt-dlp reveals the URL acquire box; disabling hides it', async ({ page }) => {
    // Baseline: no resolve plugin -> the acquire box is absent on the search page.
    await page.goto('/');
    await expect(page.getByTestId('search-input')).toBeVisible();
    await expect(page.getByTestId('acquire-url-input')).toHaveCount(0);

    // Enable yt-dlp (consent-gated) on the admin plugins page.
    await page.goto('/settings/plugins');
    const card = ytdlpCard(page);
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    await card.getByTestId('plugin-toggle').click();
    await page.getByTestId('confirm-ok').click(); // acknowledge the disclaimer
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Disable');

    // Now the acquire box is exposed on the search page.
    await page.goto('/');
    await expect(page.getByTestId('acquire-url-input')).toBeVisible();

    // Disabling it removes the capability again.
    await page.goto('/settings/plugins');
    await card.getByTestId('plugin-toggle').click();
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    await page.goto('/');
    await expect(page.getByTestId('acquire-url-input')).toHaveCount(0);
  });
});
