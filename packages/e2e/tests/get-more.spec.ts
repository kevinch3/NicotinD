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

// #2015: related artists the library lacks, one tap from a song. The response
// is stubbed: the fixture server has no listener data to relate artists by.
test('Get more ▸ Similar artists hands a not-owned artist to the Get page', async ({ page }) => {
  let asked = 0;
  await page.route('**/api/library/artists/*/related*', async (route) => {
    asked += 1;
    await route.fulfill({
      json: {
        artists: [],
        notOwned: [
          { mbid: 'mbid-1', name: 'Neighbour One', score: 0.9 },
          { mbid: 'mbid-2', name: 'Neighbour Two', score: 0.8 },
        ],
      },
    });
  });
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  const row = page.getByTestId('track-row').first();
  await row.getByTestId('track-row-menu-toggle').click();
  await row.getByTestId('track-action-Get more').click();
  await page.getByTestId('menu-flyout').getByTestId('track-action-Similar artists').click();
  // A submenu of a submenu: a second flyout, with one row per artist.
  await expect(page.getByTestId('menu-flyout')).toHaveCount(2);
  const names = page.getByTestId('menu-flyout').last();
  await expect(names.getByTestId('track-action-Neighbour One')).toBeVisible();
  const box = (await names.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(1280);
  await names.getByTestId('track-action-Neighbour Two').click();

  await expect(page).toHaveURL(/\/get\?tab=add/);
  await expect(page.getByTestId('search-input')).toHaveValue('Neighbour Two');
  expect(asked).toBe(1);
});

test('Get more has no Similar artists when the library lacks none', async ({ page }) => {
  await page.route('**/api/library/artists/*/related*', (route) =>
    route.fulfill({ json: { artists: [], reason: 'no-signal' } }),
  );
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  const row = page.getByTestId('track-row').first();
  await row.getByTestId('track-row-menu-toggle').click();
  await row.getByTestId('track-action-Get more').click();
  const flyout = page.getByTestId('menu-flyout');
  await expect(flyout.getByTestId('track-action-More by this artist')).toBeVisible();
  await expect(flyout.getByTestId('track-action-Similar artists')).toHaveCount(0);
});

// #2014: both endpoints are stubbed. A fresh server has no resolve plugin, so
// a real hunt cannot run here (docs/e2e.md).
test('Get more ▸ Get the full album confirms and starts the hunt', async ({ page }) => {
  let completeCalls = 0;
  await page.route('**/api/library/albums/*/completeness', (route) =>
    route.fulfill({
      json: { albumId: 'stub', confirmed: { expected: 9, owned: 7, missing: 2 } },
    }),
  );
  await page.route('**/api/library/albums/*/complete', async (route) => {
    completeCalls += 1;
    await route.fulfill({ json: { ok: true, outcome: 'enqueued', lidarrAlbumId: 1 } });
  });
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  const row = page.getByTestId('track-row').first();
  await row.getByTestId('track-row-menu-toggle').click();
  await row.getByTestId('track-action-Get more').click();
  const entry = page.getByTestId('menu-flyout').getByTestId('track-action-Get the full album');
  await expect(entry).toHaveText('Get the full album (2 missing)');
  await entry.click();

  const dialog = page.locator('[data-testid="confirm-dialog"]');
  await expect(dialog).toContainText(FIXTURE.album.title);
  await expect(dialog).toContainText('2 missing');
  expect(completeCalls, 'nothing is hunted before the confirm').toBe(0);
  await dialog.getByTestId('confirm-ok').click();

  await expect(page.getByText('Hunting the missing tracks')).toBeVisible();
  expect(completeCalls).toBe(1);
});

test('Get more has no Get the full album for a complete album', async ({ page }) => {
  await page.route('**/api/library/albums/*/completeness', (route) =>
    route.fulfill({ json: { albumId: 'stub', confirmed: { expected: 7, owned: 7, missing: 0 } } }),
  );
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  const row = page.getByTestId('track-row').first();
  await row.getByTestId('track-row-menu-toggle').click();
  await row.getByTestId('track-action-Get more').click();
  const flyout = page.getByTestId('menu-flyout');
  await expect(flyout.getByTestId('track-action-More by this artist')).toBeVisible();
  await expect(flyout.getByTestId('track-action-Get the full album')).toHaveCount(0);
});
