import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

const OUT = 'screenshots/mobile';

/**
 * Captures the key mobile screens for UX review. Not a correctness test — it
 * only navigates and snapshots; assertions exist purely to guarantee the screen
 * is in the expected state before the shot.
 */
test('capture mobile screens', async ({ page }) => {
  // 1) Library list (Albums grid)
  await page.goto('/library');
  await expect(page.getByTestId('album-card').first()).toBeVisible();
  await page.waitForTimeout(600); // let cover art settle
  await page.screenshot({ path: `${OUT}/01-library-list.png`, fullPage: false });

  // 2) Library album (detail + tracklist)
  await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
  await expect(page).toHaveURL(/\/library\/albums\//);
  await expect(page.getByTestId('play-album')).toBeVisible();
  await expect(page.getByText('Opening Static')).toBeVisible();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/02-library-album.png`, fullPage: false });

  // 3) Player — mini bar then full Now Playing
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/03-player-mini.png`, fullPage: false });

  // Expand to Now Playing by tapping the mini bar's track-info area.
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();
  await page.waitForTimeout(600); // slide-up transition
  await page.screenshot({ path: `${OUT}/04-player-now-playing.png`, fullPage: false });

  // 4) Song details — open the track-info sheet from the Now Playing ⋯ menu
  //    ("Song info"; the shared SongMenuService list since issue #1038).
  await page.getByTestId('now-playing-menu-toggle').click();
  await page.getByTestId('track-action-Song info').click();
  await page.waitForTimeout(800); // sheet open + acquisition/analysis fetches
  await page.screenshot({ path: `${OUT}/05-song-details.png`, fullPage: false });
  // Also capture the scrolled-down state of the sheet (Analysis / Acquisition).
  await page.mouse.wheel(0, 600);
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/06-song-details-scrolled.png`, fullPage: false });
});
