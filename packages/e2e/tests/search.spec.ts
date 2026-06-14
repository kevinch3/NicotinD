import { test, expect } from '@playwright/test';

/**
 * Phase 4 — guided acquire UX. Raw network search is demoted behind an
 * "Advanced" disclosure rather than presented as a primary "Search Soulseek
 * directly" lane. With Lidarr/slskd unreachable in e2e the catalog is empty so
 * the section is reachable; this asserts the demoted framing shipped.
 */
test.describe('search', () => {
  test('raw network search is framed as Advanced, not a primary Soulseek lane', async ({ page }) => {
    await page.goto('/');
    await page.getByTestId('search-input').fill('nonexistent test query xyz');
    await page.getByTestId('search-submit').click();

    const toggle = page.getByTestId('advanced-toggle');
    await expect(toggle).toBeVisible();
    await expect(toggle).toContainText('Advanced');
    // The old raw-first framing must be gone.
    await expect(page.getByText('Search Soulseek directly')).toHaveCount(0);
  });
});
