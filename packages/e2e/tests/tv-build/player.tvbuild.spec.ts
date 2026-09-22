/**
 * The 10-foot player on the real TV bundle — `TvPlayerComponent`, the route,
 * not the phone sheet `now-playing-tv.spec.ts` drives (#1136).
 *
 * This is where #1132 lived: every transport icon sat on the left edge of its
 * circle, on a screen no Chromium test had ever rendered. The geometry
 * assertion is the regression test; the screenshot is the net for the next
 * one.
 */
import { FIXTURE, KARAOKE_FIXTURE_LYRICS } from '../../helpers';
import { test, expect, centreOf, expectFitsTheScreen, expectNoNativeFormControls } from './tv-test';
import type { Page } from '@playwright/test';

async function playFixtureAlbum(page: Page): Promise<void> {
  await page.goto('/library');
  await page.getByTestId('tv-album-card').filter({ hasText: FIXTURE.album.title }).click();
  await page.getByTestId('tv-album-play').click();
  await expect(page).toHaveURL(/\/player$/);
  await expect(page.getByTestId('tv-player-title')).toBeVisible();
  // The blurred backdrop and the art are the same cover; wait for the art so
  // the screenshot is of the settled screen, not of the fade-in.
  const art = page.getByTestId('tv-player').locator('app-cover-art img');
  await expect
    .poll(() => art.evaluate((el: HTMLImageElement) => el.naturalWidth))
    .toBeGreaterThan(0);
}

test.describe('TV player', () => {
  test('every transport icon is centred in its button (#1132)', async ({ page }) => {
    await playFixtureAlbum(page);

    for (const id of ['tv-prev', 'tv-playpause', 'tv-next']) {
      const button = page.getByTestId(id);
      const icon = button.locator('svg');
      const b = await centreOf(button);
      const i = await centreOf(icon);
      expect(Math.abs(i.x - b.x), `${id}: icon centred horizontally`).toBeLessThanOrEqual(1);
      expect(Math.abs(i.y - b.y), `${id}: icon centred vertically`).toBeLessThanOrEqual(1);
    }
    // No seek bar: a native range input is the trap a remote cannot escape (#438).
    await expectNoNativeFormControls(page);
    await expectFitsTheScreen(
      page,
      page.getByTestId('tv-transport'),
      page.getByTestId('tv-lyrics'),
      page.getByTestId('tv-next-up'),
      page.getByTestId('tv-remote-row'),
    );
    await expect(page).toHaveScreenshot('player.png');
  });

  /**
   * A TV shell turns radio on at start (`ensureRadioOn`, #1127), and radio now
   * holds the queue at a depth rather than waiting for it to drain (#1263). So
   * the overlay lists the rest of the album *and* the radio tail behind it —
   * how much tail depends on how much the fixture library has left to offer,
   * which is why this asserts the album's remainder as a floor rather than a
   * count.
   */
  test('the Next-up chip opens the D-pad queue overlay', async ({ page }) => {
    await playFixtureAlbum(page);
    await page.getByTestId('tv-next-up').click();
    const overlay = page.getByTestId('tv-queue-overlay');
    await expect(overlay).toBeVisible();
    const rows = page.getByTestId('tv-queue-row');
    await expect(rows.first()).toBeFocused();
    expect(await rows.count()).toBeGreaterThanOrEqual(FIXTURE.album.trackCount - 1);
    await expect(page).toHaveScreenshot('player-queue.png');

    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
  });

  test('the remote row opens the full-screen output chooser (#1128)', async ({ page }) => {
    await playFixtureAlbum(page);
    await page.getByTestId('tv-remote-row').click();
    const picker = page.getByTestId('tv-device-picker');
    await expect(picker).toBeVisible();
    await expect(page.getByTestId('tv-device-row').first()).toBeFocused();
    await expectNoNativeFormControls(page);
    await expect(page).toHaveScreenshot('player-device-picker.png');

    await page.getByTestId('tv-device-picker-back').click();
    await expect(picker).toHaveCount(0);
  });

  test('Lyrics opens karaoke — the phone overlay, without its seek bar (#1134)', async ({
    page,
  }) => {
    await playFixtureAlbum(page);
    const lyricsRow = page.getByTestId('tv-lyrics');
    await expectFitsTheScreen(page, lyricsRow);
    await lyricsRow.click();

    const overlay = page.getByTestId('karaoke-overlay');
    await expect(overlay).toBeVisible();
    // The seeded plain lyrics of the first fixture track.
    for (const line of KARAOKE_FIXTURE_LYRICS.split('\n')) {
      await expect(overlay).toContainText(line);
    }
    // Plain text has no timing, so there is no auto-follow block to show.
    await expect(page.getByTestId('karaoke-fullscreen-follow')).toHaveCount(0);
    // The phone overlay carries a native range seek bar; the TV must not (#438).
    await expectNoNativeFormControls(page);
    await expect(page.getByTestId('karaoke-seek-hint')).toBeVisible();
    // ▲ ▼ work at once: the overlay took focus on entry.
    await expect(overlay).toBeFocused();
    await expect(page).toHaveScreenshot('player-karaoke.png');

    // Escape closes the overlay first — not the route — and hands focus back
    // to the row that opened it.
    await page.keyboard.press('Escape');
    await expect(overlay).toHaveCount(0);
    await expect(page).toHaveURL(/\/player$/);
    await expect(lyricsRow).toBeFocused();
  });

  test('once something plays, Home grows its "Now playing" entry', async ({ page }) => {
    await playFixtureAlbum(page);
    await page.goto('/');
    const entry = page.getByTestId('tv-nav-player');
    await expect(entry).toBeVisible();
    await expectFitsTheScreen(page, entry);
    await entry.click();
    await expect(page).toHaveURL(/\/player$/);
  });
});
