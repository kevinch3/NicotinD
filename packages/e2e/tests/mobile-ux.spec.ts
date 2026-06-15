import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * Mobile-viewport UX regressions (the G-series in
 * docs/e2e-playground-findings-2026-06.md). Runs in the CI chromium project; we
 * shrink the viewport per-spec to a phone size since the project device is
 * Desktop Chrome.
 */
const PHONE = { width: 412, height: 915 }; // Pixel 7

async function openAlbum(page: Page): Promise<void> {
  await page.goto('/library');
  await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
  await expect(page).toHaveURL(/\/library\/albums\//);
  await expect(page.getByTestId('play-album')).toBeVisible();
}

test.describe('mobile UX', () => {
  test.use({ viewport: PHONE });

  // G1 — the primary Play button must never be clipped off-screen by the
  // (now wrapping) action row.
  test('album-detail Play button is fully within the viewport', async ({ page }) => {
    await openAlbum(page);
    const box = (await page.getByTestId('play-album').boundingBox())!;
    expect(box, 'play-album should have a layout box').toBeTruthy();
    expect(box.x, 'left edge not clipped').toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, 'right edge within viewport').toBeLessThanOrEqual(PHONE.width);
  });
});
