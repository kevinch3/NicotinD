import { test, expect } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

/**
 * #2004: a song has a page of its own, so it can be linked to and shared.
 * The Playwright `request` fixture is unauthenticated (docs/e2e.md), so the
 * song's id is read from inside the page, with the page's own token.
 */
async function songId(page: import('@playwright/test').Page, title: string): Promise<string> {
  await page.goto('/library');
  await expect(page.getByTestId('album-card').first()).toBeVisible();
  return page.evaluate(async (wanted) => {
    const token = localStorage.getItem('nicotind_token');
    const res = await fetch(`/api/library/songs?limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const songs = (await res.json()) as Array<{ id: string; title: string }>;
    return songs.find((s) => s.title === wanted)!.id;
  }, title);
}

test.describe('song page', () => {
  test('opens from a link, shows the song and plays it', async ({ page }) => {
    const id = await songId(page, 'Second Wind');
    await page.goto(`/library/songs/${id}`);

    await expect(page.getByTestId('song-page-title')).toHaveText('Second Wind');
    await expect(page.getByTestId('song-page-artists')).toContainText(FIXTURE.album.artist);
    await expect(page.getByTestId('song-page-album')).toContainText(FIXTURE.album.title);
    await expect(page.getByTestId('song-page-album')).toContainText('0:30');

    await page.getByTestId('song-page-play').click();
    await expect(page.getByTestId('player-title')).toHaveText('Second Wind');

    // The album is a link to the album page.
    await page.getByTestId('song-page-album').getByRole('link').click();
    await expect(page).toHaveURL(/\/library\/albums\//);
  });

  test('an unknown id says the song is not in the library', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('album-card').first()).toBeVisible();
    await page.goto('/library/songs/no-such-song');
    await expect(page.getByTestId('song-page-not-found')).toBeVisible();
    await expect(page.getByTestId('song-page-play')).toHaveCount(0);
  });

  test('Share copies a link that opens the song for a guest, with a preview card', async ({
    page,
    browser,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const row = page.getByTestId('track-row').filter({ hasText: 'Second Wind' });
    await row.getByTestId('track-row-menu-toggle').click();
    await row.getByTestId('track-action-Share').click();
    await expect(page.getByText('Link copied')).toBeVisible();
    const url = await page.evaluate(() => navigator.clipboard.readText());
    expect(url).toMatch(/\/share\/[A-Za-z0-9_-]{22}$/);

    // What a link-preview crawler sees: the raw HTML, before any script runs.
    const html = await (await page.request.get(url)).text();
    expect(html).toContain('<meta property="og:title" content="Second Wind" />');
    expect(html).toContain('<meta property="og:type" content="music.song" />');
    expect(html).toContain(`Song • ${FIXTURE.album.artist} • ${FIXTURE.album.title}`);
    expect(html).toMatch(/<meta property="og:image" content="[^"]*\/api\/cover\//);

    // The owner, logged in, lands on the real song page.
    await page.goto(url);
    await expect(page).toHaveURL(/\/library\/songs\//);
    await expect(page.getByTestId('song-page-title')).toHaveText('Second Wind');

    // A guest gets the share view, with the song listed to play.
    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto(url);
    await expect(guestPage.getByRole('heading', { name: 'Second Wind' })).toBeVisible();
    await expect(guestPage.getByText(FIXTURE.album.artist).first()).toBeVisible();
    await guest.close();
  });
});
