import { test, expect } from '@playwright/test';
import { FIXTURE } from '../helpers';

/**
 * Likes → auto-maintained "Liked Songs" playlist (issue #225). The heart on a
 * track row toggles membership in the per-user `kind='liked'` playlist; the
 * playlists tab then shows a "Liked Songs" row (with `liked-badge-inline`) that
 * has no rename/delete controls (system-managed). See docs/song-actions.md.
 */
test.describe('likes', () => {
  test('like a track from the row heart → it appears in the Liked Songs playlist', async ({
    page,
  }) => {
    // 1. Open an album with tracks.
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first().click();
    await expect(page).toHaveURL(/\/library\/albums\//);

    const row = page.getByTestId('track-row').first();
    await expect(row).toBeVisible();

    // 2. Toggle the heart on. aria-pressed flips true.
    const heart = row.getByTestId('track-like');
    await expect(heart).toHaveAttribute('aria-pressed', 'false');
    await heart.click();
    await expect(heart).toHaveAttribute('aria-pressed', 'true');

    // 3. The Liked Songs playlist now exists on the playlists tab, carrying the
    //    heart badge and NO rename/delete controls (system-managed, read-only).
    await page.goto('/library');
    await page.getByRole('button', { name: 'Playlists', exact: true }).click();
    await expect(page.getByTestId('playlists-list')).toBeVisible();

    const likedRow = page
      .getByTestId('playlist-row')
      .filter({ has: page.getByTestId('liked-badge-inline') });
    await expect(likedRow).toBeVisible();
    await expect(likedRow.getByTestId('rename-playlist')).toHaveCount(0);
    await expect(likedRow.getByTestId('delete-playlist')).toHaveCount(0);

    // 4. Re-navigate to the album: the heart persists as liked (hydrated from
    //    /liked-ids). Unliking flips it back off.
    await page.goto('/library');
    await page.getByTestId('album-card').filter({ hasText: FIXTURE.album.title }).first().click();
    const heartAgain = page.getByTestId('track-row').first().getByTestId('track-like');
    await expect(heartAgain).toHaveAttribute('aria-pressed', 'true');
    await heartAgain.click();
    await expect(heartAgain).toHaveAttribute('aria-pressed', 'false');
  });
});
