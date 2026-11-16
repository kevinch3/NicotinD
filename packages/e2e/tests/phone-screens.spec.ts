import { test as base, expect, FIXTURE, openAlbumCard, type Page } from '../helpers';
import { pinFonts } from './helpers/pinned-fonts';

/**
 * Phone screenshot baselines (#1687): the main surfaces at a Pixel-size
 * viewport, on the default preset, with one on a light preset. They exist so a
 * palette or component change shows up as a diff a person looks at, the way the
 * `tv` project's baselines already do for the TV bundle.
 *
 * Same rules as there (docs/e2e.md): fonts pinned, Linux renderings committed as
 * `*-chromium-linux.png`, and anything that changes per run is masked, never
 * waited out. Update with `--update-snapshots` after a deliberate visual change.
 */
const test = base.extend<{ pinnedFonts: void }>({
  pinnedFonts: [
    async ({ page }, use) => {
      await pinFonts(page);
      await use();
    },
    { auto: true },
  ],
});

test.use({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 1 });

/** Every image on screen has decoded, so a cover is never caught mid-fade. */
async function settled(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() =>
        [...document.images].every((img) => img.complete && img.naturalWidth > 0),
      ),
    )
    .toBe(true);
  await page.evaluate(() => document.fonts.ready);
}

async function openLibrary(page: Page, mode: string): Promise<void> {
  await page.goto('/library');
  await page.getByTestId('library-tabs').locator(`[data-mode="${mode}"]`).click();
}

test.describe('phone screens', () => {
  test('library, albums', async ({ page }) => {
    await openLibrary(page, 'albums');
    await expect(page.getByTestId('album-card').first()).toBeVisible();
    await settled(page);
    await expect(page).toHaveScreenshot('library-albums.png');
  });

  test('library, albums, on Daylight', async ({ page }) => {
    await openLibrary(page, 'albums');
    await expect(page.getByTestId('album-card').first()).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'daylight'));
    await settled(page);
    await expect(page).toHaveScreenshot('library-albums-daylight.png');
  });

  test('library, genres', async ({ page }) => {
    await openLibrary(page, 'genre');
    await expect(page.getByTestId('genre-tile').first()).toBeVisible();
    await expect(page).toHaveScreenshot('library-genres.png');
  });

  test('album', async ({ page }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await expect(page.getByTestId('track-row').first()).toBeVisible();
    await settled(page);
    await expect(page).toHaveScreenshot('album.png');
  });

  test('now playing, at rest', async ({ page }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await page.getByTestId('play-album').click();
    await page.getByTestId('player-title').click();
    await expect(page.getByTestId('now-playing-heading')).toBeVisible();
    await expect(page.getByTestId('now-playing-tab-queue')).toBeVisible();
    await settled(page);
    // The clock, the seek bar and the play state move with playback.
    await expect(page).toHaveScreenshot('now-playing.png', {
      mask: [
        page.locator('app-now-playing-transport app-seek-bar'),
        page.locator('app-now-playing-transport app-seek-bar + div'),
        page.getByTestId('now-playing-playpause'),
      ],
    });
  });

  test('get, the Add tab', async ({ page }) => {
    await page.goto('/get');
    await expect(page.getByTestId('get-tabs')).toBeVisible();
    await settled(page);
    await expect(page).toHaveScreenshot('get-add.png');
  });
});
