import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

test.describe('playlist generator', () => {
  test('generates a playlist from an artist and opens it', async ({ page }) => {
    await page.goto('/library');

    // Album detail → artist page via the artist name link.
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first().click();
    await expect(page).toHaveURL(/\/library\/albums\//);
    await page.getByRole('link', { name: FIXTURE.album.artist }).first().click();
    await expect(page).toHaveURL(/\/library\/artists\//);

    // Kick off generation; it creates a user playlist and navigates to it.
    const generate = page.getByTestId('artist-generate-playlist');
    await expect(generate).toBeVisible();
    await generate.click();
    await expect(page).toHaveURL(/\/library\/playlists\//);

    // The generated playlist has at least one track (the fixture album feeds it).
    await expect(page.locator('app-track-row').first()).toBeVisible();
  });

  test('a generated playlist shows up under "Your playlists"', async ({ page }) => {
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first().click();
    await expect(page).toHaveURL(/\/library\/albums\//);
    await page.getByRole('link', { name: FIXTURE.album.artist }).first().click();
    await expect(page).toHaveURL(/\/library\/artists\//);
    const generate = page.getByTestId('artist-generate-playlist');
    await expect(generate).toBeVisible();
    await generate.click();
    await expect(page).toHaveURL(/\/library\/playlists\//);

    // Switch to the Playlists mode; the new user playlist is listed.
    await page.goto('/library');
    await page.getByRole('button', { name: 'Playlists', exact: true }).click();
    const userList = page.getByTestId('user-playlists');
    await expect(userList).toBeVisible();
    await expect(userList.getByRole('link')).not.toHaveCount(0);
  });
});
