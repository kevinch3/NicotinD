/**
 * Entity links everywhere — every rendered album/artist name is a link to its
 * page (`EntityLinkComponent`, `data-testid="entity-link-<kind>"`). The unit
 * harness cannot bind a nested component's inputs, so the rendered href and the
 * click-does-not-play contract are pinned here, in the real bundle.
 */
import { test, expect } from '@playwright/test';
import { FIXTURE, openAlbumCard } from '../helpers';

const ALBUM_URL = /\/library\/albums\/[^/?#]+/;

test.describe('entity links', () => {
  test('a track row’s album name links to the album page without playing the row', async ({
    page,
  }) => {
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();
    await page.getByRole('button', { name: 'Songs', exact: true }).click();
    const list = page.getByTestId('library-songs-list');
    await expect(list).toBeVisible();

    const row = list.getByTestId('track-row').first();
    const albumLink = row.getByTestId('entity-link-album');
    await expect(albumLink).toBeVisible();
    const href = await albumLink.getAttribute('href');
    expect(href, 'album name carries a routerLink href').toMatch(ALBUM_URL);

    await albumLink.click();
    await expect(page).toHaveURL(ALBUM_URL);
    await expect(page.getByTestId('play-album')).toBeVisible();
    // Following the link is navigation, not playback: the click must not reach
    // the row's play handler. The mini-player's title is an always-present
    // element that is empty while nothing has ever been played.
    await expect(page.getByTestId('player-title')).toHaveText('');
  });

  test('a track row’s artist name links to the artist page', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();
    await page.getByRole('button', { name: 'Songs', exact: true }).click();
    const row = page.getByTestId('library-songs-list').getByTestId('track-row').first();
    const artistLink = row.getByTestId('entity-link-artist').first();
    await expect(artistLink).toBeVisible();
    await artistLink.click();
    await expect(page).toHaveURL(/\/library\/artists\/[^/?#]+/);
  });

  test.describe('inside Now Playing (desktop)', () => {
    test.use({ viewport: { width: 1280, height: 800 } });

    test('the queue row’s album link navigates and collapses the sheet', async ({ page }) => {
      await page.goto('/library');
      await openAlbumCard(page, FIXTURE.album.title);
      await page.getByTestId('play-album').click();
      await expect(page.getByTestId('player-title')).toBeVisible();
      await page.getByTestId('player-title').click();
      await expect(page.getByTestId('now-playing-heading')).toBeVisible();

      const queueRow = page.getByTestId('queue-row').first();
      await expect(queueRow).toBeVisible();
      const albumLink = queueRow.getByTestId('entity-link-album');
      await expect(albumLink).toHaveAttribute('href', ALBUM_URL);

      await albumLink.click();
      await expect(page).toHaveURL(ALBUM_URL);
      await expect(page.getByTestId('play-album')).toBeVisible();
      // The sheet slides off-screen rather than unmounting (see player.spec.ts).
      await expect(page.getByTestId('now-playing-queue')).not.toBeInViewport();
    });

    test('the album line under the current track links to the album page', async ({ page }) => {
      await page.goto('/library');
      await openAlbumCard(page, FIXTURE.album.title);
      await page.getByTestId('play-album').click();
      await expect(page.getByTestId('player-title')).toBeVisible();
      await page.getByTestId('player-title').click();

      const albumLine = page.getByTestId('now-playing-album');
      await expect(albumLine).toContainText(FIXTURE.album.title);
      await albumLine.getByTestId('entity-link-album').click();
      await expect(page).toHaveURL(ALBUM_URL);
      await expect(page.getByTestId('now-playing-album')).not.toBeInViewport();
    });
  });
});
