/**
 * One album grid per artist tab (docs/web-ui.md).
 *
 * The e2e server has no Lidarr, so `GET /api/discography/artists/:id` fails and the
 * merge runs with an empty discography. That is the case worth an e2e: it is what
 * every install without Lidarr sees, and a merge bug would blank the grid entirely
 * rather than fall back to the library. The three-state tile itself is covered by
 * album-tile.component.spec.ts, which can drive the states this environment cannot
 * produce.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ADMIN, FIXTURE, bearer } from '../helpers';

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

test.describe('artist album grid', () => {
  test('falls back to the library when no discography is available', async ({ page, request }) => {
    const jwt = await token(request);
    const artists = (await (
      await request.get('/api/library/artists', { headers: bearer(jwt) })
    ).json()) as Array<{ id: string; name: string }>;
    const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
    expect(artist, 'fixture artist must exist').toBeTruthy();

    await page.goto(`/library/artists/${artist.id}`);

    // The grid renders the album we own, as a navigable tile.
    const tiles = page.getByTestId('album-tile');
    await expect(tiles.first()).toBeVisible();
    const owned = tiles.first();
    await expect(owned).toHaveAttribute('data-status', 'owned');

    // Nothing was reported missing, so nothing offers to acquire and the toggle
    // that reveals the non-studio tail has nothing to reveal.
    await expect(page.getByTestId('album-tile-action')).toHaveCount(0);
    await expect(page.getByTestId('toggle-all-releases')).toHaveCount(0);

    // No discography loaded means no summary line — and, crucially, no second grid.
    await expect(page.getByTestId('discography-summary')).toHaveCount(0);
    await expect(page.getByText('Full Discography')).toHaveCount(0);

    // The tile is a real link into the album page, not a decorative cell.
    await owned.click();
    await expect(page).toHaveURL(/\/library\/albums\//);
  });
});
