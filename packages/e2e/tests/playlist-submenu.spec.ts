import { test, expect, type Page } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

/**
 * "Add to playlist ▸" is a submenu of the song menu (#2009): a flyout beside
 * the row on desktop, a drill-in with a Back row on a phone sheet. One spec
 * walks both, because the second half needs the playlist the first half made.
 */
const NAME = `E2E submenu ${Date.now()}`;

async function songCount(page: Page, name: string): Promise<number | null> {
  return page.evaluate(async (wanted) => {
    const token = localStorage.getItem('nicotind_token');
    const res = await fetch('/api/playlists', { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { playlists: Array<{ name: string; songCount: number }> };
    return body.playlists.find((p) => p.name === wanted)?.songCount ?? null;
  }, name);
}

test.describe('Add to playlist submenu', () => {
  test.describe.configure({ mode: 'serial' });

  test('desktop: a flyout creates a playlist from a name, then adds to it', async ({ page }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const rows = page.getByTestId('track-row');
    await expect(rows.first()).toBeVisible();

    await rows.nth(0).getByTestId('track-row-menu-toggle').click();
    const parent = rows.nth(0).getByTestId('track-action-Add to playlist');
    await expect(parent).toHaveAttribute('aria-haspopup', 'menu');
    const menuHeightBefore = (await rows.nth(0).getByTestId('track-row-menu').boundingBox())!
      .height;
    await parent.click();
    const flyout = page.getByTestId('menu-flyout');
    await expect(flyout).toBeVisible();
    // Beside the menu, not over it: the menu's own rows are still there.
    await expect(rows.nth(0).getByTestId('track-action-Song info')).toBeVisible();
    const menuBox = (await rows.nth(0).getByTestId('track-row-menu').boundingBox())!;
    const flyBox = (await flyout.boundingBox())!;
    // The menu sits at the right edge here, so the flyout opens on its left,
    // fully on screen, level with the row that opened it.
    expect(flyBox.x + flyBox.width).toBeLessThanOrEqual(menuBox.x + 1);
    expect(flyBox.x).toBeGreaterThanOrEqual(0);
    const parentBox = (await parent.boundingBox())!;
    expect(Math.abs(flyBox.y - parentBox.y)).toBeLessThan(12);
    // And it did not stretch the menu it hangs beside.
    expect(Math.abs(menuBox.height - menuHeightBefore)).toBeLessThan(2);

    await flyout.getByTestId('track-action-New playlist').fill(NAME);
    await flyout.getByTestId('track-action-New playlist').press('Enter');
    await expect(rows.nth(0).getByTestId('track-row-menu')).toBeHidden();
    await expect.poll(() => songCount(page, NAME)).toBe(1);

    // A second song goes into the playlist that now exists.
    await rows.nth(1).getByTestId('track-row-menu-toggle').click();
    await rows.nth(1).getByTestId('track-action-Add to playlist').click();
    await page.getByTestId('menu-flyout').getByTestId(`track-action-${NAME}`).click();
    await expect(rows.nth(1).getByTestId('track-row-menu')).toBeHidden();
    await expect.poll(() => songCount(page, NAME)).toBe(2);
  });

  test('phone: the sheet drills in under a Back row, and Back returns', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const row = page.getByTestId('track-row').nth(2);
    await expect(row).toBeVisible();

    await row.getByTestId('track-row-menu-toggle').click();
    const sheet = page.getByTestId('track-row-menu');
    await expect(sheet).toHaveAttribute('data-presentation', 'sheet');
    await sheet.getByTestId('track-action-Add to playlist').click();

    // Drilled in: no flyout, the submenu replaces the list.
    await expect(page.getByTestId('menu-flyout')).toHaveCount(0);
    await expect(sheet.getByTestId('track-action-Back')).toBeVisible();
    await expect(sheet.getByTestId('track-action-Song info')).toHaveCount(0);
    await expect(sheet.getByTestId(`track-action-${NAME}`)).toBeVisible();
    // Rows keep the 44px touch height inside the submenu.
    const h = (await sheet.getByTestId(`track-action-${NAME}`).boundingBox())!.height;
    expect(h).toBeGreaterThanOrEqual(44);

    await sheet.getByTestId('track-action-Back').click();
    await expect(sheet.getByTestId('track-action-Song info')).toBeVisible();

    await sheet.getByTestId('track-action-Add to playlist').click();
    await sheet.getByTestId(`track-action-${NAME}`).click();
    await expect(sheet).toBeHidden();
    await expect.poll(() => songCount(page, NAME)).toBe(3);
  });

  test('phone: Escape leaves the submenu before it closes the menu', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const row = page.getByTestId('track-row').first();
    await row.getByTestId('track-row-menu-toggle').click();
    const sheet = page.getByTestId('track-row-menu');
    await sheet.getByTestId('track-action-Add to playlist').click();
    await expect(sheet.getByTestId('track-action-Back')).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(sheet.getByTestId('track-action-Song info')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });
});
