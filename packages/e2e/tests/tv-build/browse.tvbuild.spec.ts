/**
 * Browse and Album on the real TV bundle (#1136): the grid, the tabs, and the
 * album screen — cover, Play, tracklist — as the couch sees them.
 */
import { FIXTURE } from '../../helpers';
import { test, expect, expectFitsTheScreen, expectNoNativeFormControls } from './tv-test';

test.describe('TV browse', () => {
  test('albums, artists and genres are three tabs over a grid — no search, no sort', async ({
    page,
  }) => {
    await page.goto('/library');
    const card = page.getByTestId('tv-album-card').filter({ hasText: FIXTURE.album.title });
    await expect(card).toBeVisible();
    // The cover must actually render, not the letter placeholder: a tokenless
    // cover URL 401s into a gradient that looks deliberate (docs/tv-ux.md).
    const img = card.locator('img');
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
    await expectNoNativeFormControls(page);
    await expect(page).toHaveScreenshot('browse-albums.png');

    await page.locator('[data-tab="artists"]').click();
    await expect(page.getByTestId('tv-artist-card').first()).toBeVisible();
    await expect(page).toHaveScreenshot('browse-artists.png');

    // The two genre-tagged catalogues (helpers.ts `FIXTURE.genres`) are the only
    // genres in the library, so this tab has exactly those to show.
    await page.locator('[data-tab="genres"]').click();
    await expect(page.getByTestId('tv-genre-card')).toHaveCount(2);
  });

  test('an album is cover, title, Play and the tracklist', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('tv-album-card').filter({ hasText: FIXTURE.album.title }).click();
    await expect(page).toHaveURL(/\/library\/albums\//);
    const play = page.getByTestId('tv-album-play');
    await expect(play).toBeVisible();
    await expect(page.getByTestId('tv-track-row')).toHaveCount(FIXTURE.album.trackCount);
    await expectFitsTheScreen(page, play, page.getByTestId('tv-track-row').first());
    await expectNoNativeFormControls(page);
    await expect(page).toHaveScreenshot('album.png');
  });
});
