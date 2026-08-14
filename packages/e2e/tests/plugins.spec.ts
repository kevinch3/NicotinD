import { test, expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { expandGroup } from '../helpers';

/**
 * Task 4 (settings-cards unification): every kind section is a collapsible
 * `app-settings-group` and every plugin card is itself collapsible, both
 * collapsed by default — so a spec that needs to see a card, or a card's
 * body content (config form, embedded slskd settings), must expand both
 * levels first.
 */
async function expandCard(card: Locator): Promise<void> {
  const toggle = card.getByTestId('plugin-card-toggle');
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
}

/** The card lives inside its kind group's body — expand the group first, or
 *  the card locator itself never resolves. */
async function openPluginCard(page: Page, groupId: string, pluginId: string): Promise<Locator> {
  await expandGroup(page, groupId);
  const card = page.locator(`[data-testid="plugin-card"][data-plugin-id="${pluginId}"]`);
  await expect(card).toBeVisible();
  await expandCard(card);
  return card;
}

/**
 * The compliance-critical contract: acquisition UI only appears when a backing
 * plugin is enabled. The link-intent card is gated on `hasResolve()` (any enabled
 * `resolve`-capable plugin), not on the URL matching a specific one. spotdl is the
 * last in-process consent-gated `resolve` plugin, default-off (yt-dlp/archive are
 * addons now), so it's the one that drives this gate.
 */
test.describe('plugin capability gating', () => {
  const spotdlCard = async (page: Page) => openPluginCard(page, 'plugins-acquisition', 'spotdl');

  test.afterEach(async ({ page }) => {
    // Leave spotdl disabled so the suite stays order-independent.
    await page.goto('/settings/plugins');
    const card = await spotdlCard(page);
    if ((await card.getByTestId('plugin-toggle').textContent())?.trim() === 'Disable') {
      await card.getByTestId('plugin-toggle').click();
      await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    }
  });

  test('enabling a resolve plugin reveals the link-intent card for a pasted URL; disabling hides it', async ({
    page,
  }) => {
    const pasteUrl = async () => {
      await page
        .getByTestId('search-input')
        .fill('https://open.spotify.com/album/1DFixLWuPkv3KT3TnV35m3');
      await page.getByTestId('search-submit').click();
    };

    // Baseline: no resolve plugin -> pasting a URL just searches, no card.
    await page.goto('/search');
    await expect(page.getByTestId('search-input')).toBeVisible();
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);

    // Enable spotdl (consent-gated) on the admin plugins page.
    await page.goto('/settings/plugins');
    const card = await spotdlCard(page);
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
    const card2 = await spotdlCard(page);
    await card2.getByTestId('plugin-toggle').click();
    await expect(card2.getByTestId('plugin-toggle')).toHaveText('Enable');
    await page.goto('/search');
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);
  });

  test('the archive.org plugin ships registered and default-off', async ({ page }) => {
    await page.goto('/settings/plugins');
    const card = await openPluginCard(page, 'plugins-acquisition', 'bundled-archive');
    // Compliance posture: a fresh install enables nothing.
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
  });

  test('the Spotify plugin ships registered, default-off, with a credentials form', async ({
    page,
  }) => {
    await page.goto('/settings/plugins');
    const card = await openPluginCard(page, 'plugins-acquisition', 'spotify');
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

  // Regression: the web `PluginKind` union omitted 'metadata', so LRCLIB —
  // registered AND seeded enabled on the server — matched no group computed and
  // no template section. It was live but unmanageable: an admin could not see
  // it, disable it, or read what it does.
  test('the LRCLIB metadata extension is visible and manageable', async ({ page }) => {
    await page.goto('/settings/plugins');
    const card = await openPluginCard(page, 'plugins-metadata', 'lrclib');
    // Default-on (keyless, benign) — unlike every acquisition plugin.
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Disable');
  });

  test('the From Spotify lane stays hidden while the plugin is disabled', async ({ page }) => {
    await page.goto('/search');
    await page.getByTestId('search-input').fill('nina simone');
    await page.getByTestId('search-input').press('Enter');
    // Gated on the spotify plugin (default-off), so the lane never appears.
    await expect(page.getByTestId('spotify-section')).toHaveCount(0);
  });
});
