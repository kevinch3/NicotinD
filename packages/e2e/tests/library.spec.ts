import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

test.describe('library', () => {
  test('shows the fixture album in the grid and its tracklist', async ({ page }) => {
    await page.goto('/library');

    const card = page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title });
    await expect(card).toBeVisible();

    await card.click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    // Album detail renders the title and the bookend tracks of the 7-track album.
    await expect(page.getByText(FIXTURE.album.title, { exact: false }).first()).toBeVisible();
    await expect(page.getByText('Opening Static')).toBeVisible();
    await expect(page.getByText('Closing Time')).toBeVisible();
  });

  test('the loose single is not in the Albums grid', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();
    // The single is bucketed as a single, so it must not appear among albums.
    await expect(
      page.getByTestId('album-card').filter({ hasText: FIXTURE.single.title }),
    ).toHaveCount(0);
  });
});
