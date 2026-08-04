/**
 * Android TV player layout — a 1080p TV at density 320 gives the WebView a
 * 960×540 CSS viewport, *below* Tailwind's lg (1024px), so Now Playing used
 * to render the mobile stacked sheet in a short landscape window and the
 * cover pushed the transport below the fold (the "only shows the art cover"
 * bug). TV builds now get a dedicated player treatment: blurred-cover
 * backdrop, centered art, bottom-pinned glass transport (no shuffle/repeat),
 * and a "Next up" chip instead of the stacked queue panel.
 *
 * Components read TV-ness from the `tv-build` root class (isTvUi) — stamped
 * by main.ts on real TV builds — so stamping it here exercises the real TV
 * template in the prod bundle. Pure layout behavior: needs a browser engine.
 */
import { test, expect, type Page } from '@playwright/test';
import { FIXTURE } from '../helpers';

// 1080p TV / Google TV emulator: 1920×1080 physical at DPR 2.
const TV_VIEWPORT = { width: 960, height: 540 };

async function openNowPlaying(page: Page): Promise<void> {
  await page.goto('/library');
  await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).click();
  await expect(page).toHaveURL(/\/library\/albums\//);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  await expect(page.getByText('Now Playing')).toBeVisible();
}

test.describe('Now Playing on a TV viewport (tv-build)', () => {
  test.use({ viewport: TV_VIEWPORT });

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      // documentElement may not exist yet at init-script time — stamp as soon
      // as it does, and always before app scripts run (the app reads the
      // class at component construction via isTvUi()).
      const stamp = () => document.documentElement?.classList.add('tv-build');
      stamp();
      document.addEventListener('readystatechange', stamp);
      new MutationObserver(stamp).observe(document, { childList: true });
    });
  });

  test('the transport bar is pinned to the bottom and fully on screen', async ({ page }) => {
    await openNowPlaying(page);

    const playPause = page.getByTestId('now-playing-playpause');
    // Auto-retries until the sheet's 300ms slide-up transition settles — a
    // bare boundingBox() read mid-animation measures the translated position.
    await expect(playPause, 'play/pause fully inside the viewport').toBeInViewport({ ratio: 1 });
    const box = (await playPause.boundingBox())!;
    expect(box.y, 'transport lives in the bottom third (pinned bar)').toBeGreaterThan(
      (TV_VIEWPORT.height * 2) / 3,
    );

    const cover = (await page.getByTestId('now-playing-cover').boundingBox())!;
    expect(cover.height, 'cover capped so the stack fits').toBeLessThan(300);
  });

  test('shuffle and repeat are absent on the TV transport', async ({ page }) => {
    await openNowPlaying(page);
    await expect(page.getByTestId('now-playing-playpause')).toBeVisible();
    await expect(page.getByTestId('now-playing-shuffle')).toHaveCount(0);
    await expect(page.getByTestId('now-playing-repeat')).toHaveCount(0);
  });

  test('the stacked queue panel is replaced by a top-right Next-up chip', async ({ page }) => {
    await openNowPlaying(page);

    const chip = page.getByTestId('now-playing-next-up');
    // Album playback queues the album — the chip names track 2 (fixture
    // album track titles live in scripts/make-fixtures.ts).
    await expect(chip).toContainText('Second Wind');
    // Poll past the sheet's slide-up transition: the chip is anchored to the
    // translating sheet, so its y only settles when the animation ends.
    await expect
      .poll(async () => (await chip.boundingBox())!.y, { message: 'chip settles at the top' })
      .toBeLessThan(100);
    const chipBox = (await chip.boundingBox())!;
    expect(chipBox.x, 'chip sits on the right half').toBeGreaterThan(TV_VIEWPORT.width / 2);

    await expect(page.getByTestId('now-playing-queue')).toHaveCount(0);
    await expect(page.getByTestId('now-playing-queue-resize')).toHaveCount(0);
  });

  test('the sheet carries the blurred-cover backdrop hook', async ({ page }) => {
    await openNowPlaying(page);
    // The backdrop custom property is bound whenever the track has cover art;
    // the silent fixtures have none, so assert the ::before layer exists and
    // the binding stays empty rather than broken.
    const before = await page
      .getByTestId('now-playing-body')
      .evaluate((el) =>
        getComputedStyle(el.parentElement as Element, '::before').getPropertyValue('position'),
      );
    expect(before).toBe('absolute');
  });
});
