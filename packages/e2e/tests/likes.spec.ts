import { test, expect } from '@playwright/test';
import { FIXTURE, openAlbumCard } from '../helpers';

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
    await openAlbumCard(page, FIXTURE.album.title);

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
    //    /liked-ids). Unliking flips it back off. The library remembers the last
    //    tab (localStorage), so step 3 left it on Playlists — reselect Albums
    //    before looking for the album card.
    await page.goto('/library');
    await page.getByRole('button', { name: 'Albums', exact: true }).click();
    await openAlbumCard(page, FIXTURE.album.title);
    const heartAgain = page.getByTestId('track-row').first().getByTestId('track-like');
    await expect(heartAgain).toHaveAttribute('aria-pressed', 'true');
    await heartAgain.click();
    await expect(heartAgain).toHaveAttribute('aria-pressed', 'false');
  });

  test('like from the mini-player / Now Playing heart mirrors the track row (quick interaction)', async ({
    page,
  }) => {
    // The like heart used to be reachable only via the row / track-info sheet /
    // ⋯ menu — a bug, since the player is the surface a listener is already
    // looking at. Both the mini-player bar and the full-screen Now Playing
    // sheet now carry their own heart, wired to the same LikeService.
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title')).toBeVisible();

    const playerHeart = page.getByTestId('player-like');
    await expect(playerHeart).toHaveAttribute('aria-pressed', 'false');
    await playerHeart.click();
    await expect(playerHeart).toHaveAttribute('aria-pressed', 'true');

    // Mirrors onto the row for the same (currently playing) track.
    const row = page.getByTestId('track-row').first();
    await expect(row.getByTestId('track-like')).toHaveAttribute('aria-pressed', 'true');

    // Open Now Playing — its own heart reads the same liked state...
    await page.getByTestId('player-title').click();
    const nowPlayingHeart = page.getByTestId('now-playing-like');
    await expect(nowPlayingHeart).toHaveAttribute('aria-pressed', 'true');

    // ...and unliking from there flips the mini-player heart back too.
    await nowPlayingHeart.click();
    await expect(nowPlayingHeart).toHaveAttribute('aria-pressed', 'false');
    await page.getByTestId('now-playing-close').click();
    await expect(playerHeart).toHaveAttribute('aria-pressed', 'false');
  });
});
