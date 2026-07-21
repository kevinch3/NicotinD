import { test, expect } from '@playwright/test';

/**
 * Source-agnostic search UX. Soulseek is no longer framed as "the network": the
 * status line is source-neutral, raw peer browsing is demoted behind an
 * "Advanced" disclosure, and there is no longer a "From archive.org"/"From
 * Spotify" hierarchy — every source flows into one blended Results list. With
 * Lidarr/slskd unreachable in e2e the catalog is empty so these are reachable.
 */
test.describe('search', () => {
  test('the Soulseek peer lane is hidden when Soulseek is not an available source', async ({
    page,
  }) => {
    // The e2e server has no Soulseek creds (the network provider is disabled), so a
    // user without the slskd extension must never see the raw peer-browsing lane —
    // nor a nonsensical "No Soulseek results" empty state for a source they don't have.
    await page.goto('/search');
    await page.getByTestId('search-input').fill('nonexistent test query xyz');
    await page.getByTestId('search-submit').click();

    // The status line confirms we're in the no-sources state (search has settled).
    await expect(page.getByTestId('source-status')).toContainText('No acquisition sources enabled');

    await expect(page.getByTestId('advanced-network-search')).toHaveCount(0);
    await expect(page.getByText(/No Soulseek results/)).toHaveCount(0);
    // The old raw-first framing must also be gone.
    await expect(page.getByText('Search Soulseek directly')).toHaveCount(0);
  });

  test('source status is neutral, not "Soulseek network available"', async ({ page }) => {
    await page.goto('/search');
    // The status line reframes from a Soulseek-centric label to a neutral
    // "Sources: …" / "No acquisition sources enabled" line.
    await expect(page.getByText('Soulseek network available')).toHaveCount(0);
    await expect(page.getByTestId('source-status')).toBeVisible();
  });
});
