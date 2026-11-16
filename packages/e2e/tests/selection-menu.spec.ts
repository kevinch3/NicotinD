import { test, expect, type Page } from '../helpers';

/**
 * #2012: with several songs selected, a selected row's ⋯ and the selection
 * bar's ⋯ open one menu that acts on all of them.
 */
const NAME = `E2E selection ${Date.now()}`;

async function songCount(page: Page, name: string): Promise<number | null> {
  return page.evaluate(async (wanted) => {
    const token = localStorage.getItem('nicotind_token');
    const res = await fetch('/api/playlists', { headers: { Authorization: `Bearer ${token}` } });
    const body = (await res.json()) as { playlists: Array<{ name: string; songCount: number }> };
    return body.playlists.find((p) => p.name === wanted)?.songCount ?? null;
  }, name);
}

async function selectThree(page: Page) {
  await page.goto('/library');
  await expect(page.getByTestId('album-card').first()).toBeVisible();
  await page.getByRole('button', { name: 'Songs', exact: true }).click();
  const rows = page.getByTestId('library-songs-list').getByTestId('track-row');
  await expect(rows.nth(3)).toBeVisible();
  await page.getByRole('button', { name: 'Select', exact: true }).click();
  for (const i of [0, 1, 2]) await rows.nth(i).getByTestId('track-row-select').click();
  await expect(page.getByText('3 selected')).toBeVisible();
  return rows;
}

test.describe('the song menu acts on the selection', () => {
  test.describe.configure({ mode: 'serial' });

  test("a selected row's menu adds all three to a new playlist", async ({ page }) => {
    const rows = await selectThree(page);

    // An unselected row keeps its own menu.
    await rows.nth(3).getByTestId('track-row-menu-toggle').click();
    await expect(rows.nth(3).getByTestId('track-action-Song info')).toBeVisible();
    await page.keyboard.press('Escape');

    await rows.nth(1).getByTestId('track-row-menu-toggle').click();
    const menu = rows.nth(1).getByTestId('track-row-menu');
    await expect(menu.getByTestId('track-action-Like all')).toBeVisible();
    await expect(menu.getByTestId('track-action-Song info')).toHaveCount(0);
    await menu.getByTestId('track-action-Add to playlist').click();
    const field = page.getByTestId('menu-flyout').getByTestId('track-action-New playlist');
    await field.fill(NAME);
    await field.press('Enter');

    await expect.poll(() => songCount(page, NAME)).toBe(3);
    // The action ends select mode.
    await expect(page.getByTestId('selection-add')).toHaveCount(0);
  });

  test("the selection bar's ⋯ opens the same menu", async ({ page }) => {
    await selectThree(page);
    await page.getByTestId('selection-more').click();
    const menu = page.getByTestId('entity-menu');
    await expect(menu.getByTestId('entity-action-Like all')).toBeVisible();
    await expect(menu.getByTestId('entity-action-Play next')).toBeVisible();
    await menu.getByTestId('entity-action-Add to playlist').click();
    // The playlist the first test made is offered; this one makes its own, so
    // the count proves all three arrived through the bar.
    const flyout = page.getByTestId('menu-flyout');
    await expect(flyout.getByTestId(`entity-action-${NAME}`)).toBeVisible();
    const field = flyout.getByTestId('entity-action-New playlist');
    await field.fill(`${NAME} bar`);
    await field.press('Enter');
    await expect.poll(() => songCount(page, `${NAME} bar`)).toBe(3);
    await expect(page.getByTestId('selection-add')).toHaveCount(0);
  });

  test('on a phone the sheet says how many songs it acts on', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const rows = await selectThree(page);
    await rows.nth(0).getByTestId('track-row-menu-toggle').click();
    await expect(rows.nth(0).getByTestId('menu-header')).toHaveText('3 songs selected');
  });
});
