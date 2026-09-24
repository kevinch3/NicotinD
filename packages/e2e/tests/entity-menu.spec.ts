import { test, expect, type Page } from '../helpers';
import { FIXTURE } from '../helpers';

/**
 * One tile interaction standard (#1298): hover reveals ⋯, right-click and
 * tap-and-hold open the same menu, on every tile and row. Desktop Chrome can
 * drive hover and right-click; the touch hold is unit-tested and a real-device
 * gate (docs/web-ui.md).
 */
async function openLibraryAlbums(page: Page): Promise<void> {
  await page.goto('/library');
  await expect(page.getByTestId('album-card').first()).toBeVisible();
}

test.describe('entity menu', () => {
  test('right-click on an album card opens the menu with Start radio first, and it starts one', async ({
    page,
  }) => {
    await openLibraryAlbums(page);
    const card = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first();
    await card.click({ button: 'right' });

    const menu = page.getByTestId('entity-menu');
    await expect(menu).toBeVisible();
    const labels = await menu.locator('button').allTextContents();
    expect(labels[0]?.trim()).toBe('Start radio');
    expect(page.url()).toContain('/library'); // a right-click never navigated

    await page.getByTestId('entity-action-Start radio').click();
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('player-title')).toBeVisible();
  });

  test('hover reveals ⋯ on an album card and it opens the same menu without following the link', async ({
    page,
  }) => {
    await openLibraryAlbums(page);
    const card = page.getByTestId('album-card').first();
    const more = card.getByTestId('entity-menu-button');
    await expect(more).toHaveCSS('opacity', '0');
    await card.hover();
    await expect(more).toHaveCSS('opacity', '1');
    await more.click();
    await expect(page.getByTestId('entity-menu')).toBeVisible();
    expect(page.url()).toMatch(/\/library$/);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('entity-menu')).toHaveCount(0);
  });

  test('the same menu on an artist card, a genre card and a playlist row', async ({ page }) => {
    await page.goto('/library');
    const tabs = page.getByTestId('library-tabs');
    await tabs.getByRole('button', { name: 'Artists', exact: true }).click();
    await page.locator('a[href*="/library/artists/"]').first().click({ button: 'right' });
    await expect(page.getByTestId('entity-action-Start radio')).toBeVisible();
    await page.keyboard.press('Escape');

    await tabs.getByRole('button', { name: 'Genre', exact: true }).click();
    await page.locator('a[href*="/library/genres/"]').first().click({ button: 'right' });
    await expect(page.getByTestId('entity-action-Start radio')).toBeVisible();
    await page.keyboard.press('Escape');

    await tabs.getByRole('button', { name: 'Playlists', exact: true }).click();
    // The fixture library carries no playlist until another spec makes one.
    const row = page.getByTestId('playlist-row').first();
    if ((await row.count()) > 0) {
      await row.click({ button: 'right' });
      await expect(page.getByTestId('entity-action-Start radio')).toBeVisible();
      await page.keyboard.press('Escape');
    }
  });

  test('right-click on a track row opens its ⋯ list', async ({ page }) => {
    await page.goto('/library');
    await page
      .getByTestId('library-tabs')
      .getByRole('button', { name: 'Songs', exact: true })
      .click();
    await page.getByTestId('track-row').first().click({ button: 'right' });
    await expect(page.getByTestId('entity-menu')).toBeVisible();
    await expect(page.getByTestId('entity-action-Start radio')).toBeVisible();
    await page.keyboard.press('Escape');
  });
});
