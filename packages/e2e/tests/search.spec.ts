import { test, expect } from '@playwright/test';

/**
 * Source-agnostic search UX. Soulseek is no longer framed as "the network": the
 * status line is source-neutral, raw peer browsing is demoted behind an
 * "Advanced" disclosure, and there is no longer a "From archive.org"/"From
 * Spotify" hierarchy — every source flows into one blended Results list. With
 * Lidarr/slskd unreachable in e2e the catalog is empty so these are reachable.
 */
test.describe('search', () => {
  test('raw peer browsing is framed as Advanced, not a primary Soulseek lane', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('search-input').fill('nonexistent test query xyz');
    await page.getByTestId('search-submit').click();

    const toggle = page.getByTestId('advanced-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Advanced');
    // The old raw-first framing must be gone.
    await expect(page.getByText('Search Soulseek directly')).toHaveCount(0);
  });

  test('source status is neutral, not "Soulseek network available"', async ({ page }) => {
    await page.goto('/');
    // The status line reframes from a Soulseek-centric label to a neutral
    // "Sources: …" / "No acquisition sources enabled" line.
    await expect(page.getByText('Soulseek network available')).toHaveCount(0);
    await expect(page.getByTestId('source-status')).toBeVisible();
  });
});
