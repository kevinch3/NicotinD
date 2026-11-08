import { test, expect } from '../helpers';
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
 * resolve source is enabled. The link-intent card is gated on `hasResolve()` (any
 * enabled `resolve`-capable plugin/addon), not on the URL matching a specific one.
 * Every URL resolver is an addon now (yt-dlp/spotdl external, archive bundled), so
 * the bundled-archive addon — consent-gated, default-off, always present — is the
 * one that drives this gate in the e2e environment (no external addon registered).
 */
test.describe('plugin capability gating', () => {
  const archiveCard = async (page: Page) =>
    openPluginCard(page, 'plugins-acquisition', 'bundled-archive');

  test.afterEach(async ({ page }) => {
    // Leave the archive addon disabled so the suite stays order-independent.
    await page.goto('/settings/plugins');
    const card = await archiveCard(page);
    if ((await card.getByTestId('plugin-toggle').textContent())?.trim() === 'Disable') {
      await card.getByTestId('plugin-toggle').click();
      await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    }
  });

  test('enabling a resolve source reveals the link-intent card for a pasted URL; disabling hides it', async ({
    page,
  }) => {
    const pasteUrl = async () => {
      await page.getByTestId('search-input').fill('https://archive.org/details/some-item');
      await page.getByTestId('search-submit').click();
    };

    // Baseline: no resolve source -> pasting a URL just searches, no card, and
    // no live recognition either (#1663).
    await page.goto('/search');
    await expect(page.getByTestId('search-input')).toBeVisible();
    await page.getByTestId('search-input').fill('https://archive.org/details/some-item');
    await expect(page.getByTestId('search-link-chip')).toHaveCount(0);
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);

    // Enable the bundled archive addon (consent-gated) on the admin plugins page.
    await page.goto('/settings/plugins');
    const card = await archiveCard(page);
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
    const card2 = await archiveCard(page);
    await card2.getByTestId('plugin-toggle').click();
    await expect(card2.getByTestId('plugin-toggle')).toHaveText('Enable');
    await page.goto('/search');
    await pasteUrl();
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);
  });

  // #1663: a pasted link is recognised live, before submit, against the
  // patterns the enabled resolvers declare — and a paste never submits itself.
  test('a pasted link is recognised before submit, and a link no source claims says so', async ({
    page,
  }) => {
    await page.goto('/settings/plugins');
    const card = await archiveCard(page);
    await card.getByTestId('plugin-toggle').click();
    await page.getByTestId('confirm-ok').click();
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Disable');

    await page.goto('/search');
    const input = page.getByTestId('search-input');
    await expect(input).toBeVisible();
    await expect(page.getByTestId('search-submit')).toHaveText('Search');

    // fill() is one input event carrying the whole URL — what a paste is.
    await input.fill('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
    const chip = page.getByTestId('search-link-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAttribute('data-source', 'youtube');
    await expect(page.getByTestId('search-link-kind')).toHaveText('video');
    // A screen reader hears the kind too, not just the host.
    await expect(page.getByTestId('search-link-status')).toHaveAttribute('role', 'status');
    await expect(page.getByTestId('search-link-status')).toHaveText(
      /Recognised link:\s*YouTube\s*video/,
    );
    await expect(page.getByTestId('search-submit')).toHaveText('Get');
    // Only the archive addon is enabled, and its urlPatterns do not claim YouTube.
    await expect(page.getByTestId('search-link-unsupported')).toBeVisible();
    // Nothing was submitted by the paste.
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);

    // A link the archive addon does claim drops the hint; Enter opens the card.
    await input.fill('https://archive.org/details/some-item');
    await expect(chip).toHaveAttribute('data-source', 'archive');
    await expect(page.getByTestId('search-link-unsupported')).toHaveCount(0);
    await expect(page.getByTestId('link-intent-card')).toHaveCount(0);
    await input.press('Enter');
    await expect(page.getByTestId('link-intent-card')).toBeVisible();

    // Back to words: the chip goes and the button reads Search again.
    await input.fill('nina simone');
    await expect(chip).toHaveCount(0);
    await expect(page.getByTestId('search-submit')).toHaveText('Search');
  });

  // #1728: enabling archive.org used to turn on its link resolve only. The Add
  // page still said "No acquisition sources enabled" and a keyword search never
  // asked archive.org, because the search gates looked for the retired
  // in-process plugin id 'archive' instead of the bundled 'bundled-archive'.
  test('enabling archive.org makes it a named source that keyword search asks', async ({
    page,
  }) => {
    await page.goto('/settings/plugins');
    const card = await archiveCard(page);
    await card.getByTestId('plugin-toggle').click();
    await page.getByTestId('confirm-ok').click();
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Disable');

    await page.goto('/search');
    await expect(page.getByTestId('source-status')).toContainText('Internet Archive');

    // The lane is asked, and the server's gate lets it through. archive.org
    // itself is unreachable from the e2e sandbox, so the body may be an
    // upstream failure, but never the "archive.org is disabled" refusal.
    const archive = page.waitForResponse((r) => r.url().includes('/api/archive/search'));
    await page.getByTestId('search-input').fill('nina simone');
    await page.getByTestId('search-submit').click();
    const res = await archive;
    expect(await res.text()).not.toContain('archive.org is disabled');
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
