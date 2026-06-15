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

/** Play the fixture album and expand the mini-player into the Now Playing sheet. */
async function openNowPlaying(page: Page): Promise<void> {
  await openAlbum(page);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  await expect(page.getByText('Now Playing')).toBeVisible();
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

  // G2 — Now Playing renders covers via app-cover-art, so a missing/404 cover
  // degrades to the gradient fallback (no broken-image glyph). The fixtures have
  // no embedded art, so the hero cover must show the fallback initial and have
  // no <img> element (app-cover-art swaps to the gradient div on error).
  test('Now Playing hero cover degrades to the gradient fallback', async ({ page }) => {
    await openNowPlaying(page);

    const cover = page.getByTestId('now-playing-cover');
    await expect(cover).toBeVisible();
    // Fallback active: no <img> survives (it errors → gradient div) and the
    // album initial ("E" for "E2E Test Album") is shown over the gradient.
    await expect(cover.locator('img')).toHaveCount(0);
    await expect(cover).toContainText('E');
  });

  // G3 — the Track-info sheet must show which track it is (title/artist), even
  // when opened from the player (where no full library Song is passed).
  test('Track-info sheet shows the song identity', async ({ page }) => {
    await openNowPlaying(page);
    // Open the title context menu → "Track info" (scope to the menu; a visible
    // info button with the same label also exists — see the G4 test).
    await page.getByRole('heading', { name: 'Opening Static' }).click({ button: 'right' });
    await page.locator('app-track-context-menu').getByRole('button', { name: 'Track info' }).click();

    const identity = page.getByTestId('track-info-identity');
    await expect(identity).toBeVisible();
    await expect(identity).toContainText('Opening Static');
    await expect(identity).toContainText(FIXTURE.album.artist);
  });

  // G4 — a *visible* Track-info affordance on Now Playing (previously the sheet
  // was reachable only via long-press/right-click on the title).
  test('Now Playing has a visible Track-info button that opens the sheet', async ({ page }) => {
    await openNowPlaying(page);
    const infoBtn = page.getByTestId('now-playing-info');
    await expect(infoBtn).toBeVisible();
    await infoBtn.click();
    await expect(page.getByTestId('track-info-identity')).toContainText('Opening Static');
  });
});
