import { test, expect, FIXTURE, openAlbumCard, type Page } from '../helpers';

/**
 * #1751 parts 2 and 4. Offline, the album and artist pages need the server, so
 * a link to one was dead: an album or artist name now opens the Library's saved
 * songs filtered to it. And a server that stops answering while the device is
 * online is offline mode too, so the preserved covers show then as well.
 */

async function setOffline(page: Page, offline: boolean): Promise<void> {
  await page.context().setOffline(offline);
  // The DOM event is not reliably delivered under load (offline.spec.ts).
  await page.evaluate((t) => window.dispatchEvent(new Event(t)), offline ? 'offline' : 'online');
}

async function saveFixtureAlbum(page: Page): Promise<number> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  const total = await page.getByTestId('track-row').count();
  await page.getByRole('button', { name: 'Download album' }).click();
  await expect(page.getByRole('button', { name: 'Downloaded — remove offline' })).toBeVisible({
    timeout: 30_000,
  });
  return total;
}

test('offline, the album link in Now Playing opens the saved songs filtered to it', async ({
  page,
}) => {
  const total = await saveFixtureAlbum(page);
  await setOffline(page, true);
  await page.getByTestId('play-album').click();
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();

  const link = page.getByTestId('now-playing-album').getByTestId('entity-link-album');
  await expect(link).toHaveAttribute('data-offline-link', '');
  await link.click();

  await expect(page).toHaveURL(/\/library\?find=/);
  await expect(page.getByTestId('library-songs-offline-search')).toHaveValue(FIXTURE.album.title);
  await expect(page.getByTestId('library-songs-offline-list').getByTestId('track-row')).toHaveCount(
    total,
  );
  await setOffline(page, false);
});

test.describe('server unreachable while the device is online', () => {
  test.use({ serviceWorkers: 'block' });

  test('the saved covers show, as when the device is offline', async ({ page }) => {
    await saveFixtureAlbum(page);
    await page.goto('/library');
    await expect(page.getByTestId('library-find')).toBeVisible();

    // The server "dies"; a post-boot API call trips offline mode (offline.spec.ts).
    await page.route('**/api/**', (route) => route.abort());
    await page.getByTestId('library-find').fill('anything');
    await expect(page.getByTestId('offline-banner')).toBeVisible();
    // Back to the plain Library (the search that tripped it holds the page).
    await page.goto('/library');
    await expect(page.getByTestId('offline-banner')).toBeVisible();

    const cover = page
      .getByTestId('library-songs-offline-list')
      .getByTestId('track-row')
      .first()
      .locator('img')
      .first();
    await expect(cover).toHaveAttribute('src', /^blob:/);
    await expect
      .poll(() => cover.evaluate((el) => (el as HTMLImageElement).naturalWidth))
      .toBeGreaterThan(0);
  });
});
