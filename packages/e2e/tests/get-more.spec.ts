import { test, expect } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

// #2013: someone who can acquire gets from a song to its artist's discography.
test('Get more ▸ More by the artist opens the artist page', async ({ page }) => {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  const row = page.getByTestId('track-row').first();
  await row.getByTestId('track-row-menu-toggle').click();
  await row.getByTestId('track-action-Get more').click();
  const entry = page.getByTestId('menu-flyout').getByTestId('track-action-More by this artist');
  await expect(entry).toContainText(FIXTURE.album.artist);
  await entry.click();
  await expect(page).toHaveURL(/\/library\/artists\//);
  await expect(page.getByRole('heading', { name: FIXTURE.album.artist }).first()).toBeVisible();
});
