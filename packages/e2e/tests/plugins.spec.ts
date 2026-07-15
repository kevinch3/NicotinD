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

  test('enabling yt-dlp reveals the link-intent card for a pasted URL; disabling hides it', async ({
    page,
  }) => {
    const pasteUrl = async () => {
      await page.getByTestId('search-input').fill('https://youtu.be/dQw4w9WgXcQ');
      await page.getByTestId('search-submit').click();
    };

    // Baseline: no resolve plugin -> pasting a URL just searches, no card.
    await page.goto('/search');
    await expect(page.getByTestId('search-input')).toBeVisible();
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);

    // Enable yt-dlp (consent-gated) on the admin plugins page.
    await page.goto('/settings/plugins');
    const card = ytdlpCard(page);
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    await card.getByTestId('plugin-toggle').click();
    await page.getByTestId('confirm-ok').click(); // acknowledge the disclaimer
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Disable');

    // Now pasting a URL renders the link-intent card instead of searching.
    await page.goto('/search');
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toBeVisible();

    // Disabling it removes the capability again.
    await page.goto('/settings/plugins');
    await card.getByTestId('plugin-toggle').click();
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    await page.goto('/search');
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);
  });

  test('the archive.org plugin ships registered and default-off', async ({ page }) => {
    await page.goto('/settings/plugins');
    const card = page.locator('[data-testid="plugin-card"][data-plugin-id="archive"]');
    await expect(card).toBeVisible();
    // Compliance posture: a fresh install enables nothing.
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
  });

  test('the Spotify plugin ships registered, default-off, with a credentials form', async ({
    page,
  }) => {
    await page.goto('/settings/plugins');
    const card = page.locator('[data-testid="plugin-card"][data-plugin-id="spotify"]');
    await expect(card).toBeVisible();
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    // The generic config-field form renders the Spotify API credentials, with the
    // secret as a write-only password input.
    await expect(card.getByTestId('plugin-config-form')).toBeVisible();
    await expect(card.getByTestId('plugin-config-clientId')).toBeVisible();
    await expect(card.getByTestId('plugin-config-clientSecret')).toHaveAttribute(
      'type',
      'password',
    );
  });

  test('the slskd card links to its own extension page (disabled notice when off)', async ({
    page,
  }) => {
    await page.goto('/settings/plugins');
    const card = page.locator('[data-testid="plugin-card"][data-plugin-id="slskd"]');
    await expect(card).toBeVisible();
    // Bespoke settings live on the extension's own page, not an inline form.
    await card.getByTestId('plugin-configure').click();
    await expect(page).toHaveURL(/\/settings\/plugins\/slskd$/);
    await expect(page.getByTestId('slskd-settings')).toBeVisible();
    // Acquisition is default-off in e2e, so the extension shows its enable-first notice.
    await expect(page.getByTestId('slskd-disabled-notice')).toBeVisible();
  });

  test('the From Spotify lane stays hidden while the plugin is disabled', async ({ page }) => {
    await page.goto('/search');
    await page.getByTestId('search-input').fill('nina simone');
    await page.getByTestId('search-input').press('Enter');
    // Gated on the spotify plugin (default-off), so the lane never appears.
    await expect(page.getByTestId('spotify-section')).toHaveCount(0);
  });
});
