import { test, expect, type APIRequestContext } from '../helpers';
import { ADMIN, FIXTURE, bearer } from '../helpers';

/**
 * Adding an artist to Lidarr is an explicit action (issue #644): the artist page's
 * discography read answers "not provisioned", the user presses Add, the page shows
 * the pending job and loads the discography once it finishes.
 *
 * The e2e server has no Lidarr, so the three discography endpoints are stubbed at
 * the network seam; the server half (read-only GET, 202 job, status, cancel) is
 * covered by routes/discography.provision.test.ts against real services.
 */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

test.describe('add artist to Lidarr', () => {
  test('Add runs the job with a pending state, then shows the discography', async ({
    page,
    request,
  }) => {
    const jwt = await token(request);
    const artists = (await (
      await request.get('/api/library/artists', { headers: bearer(jwt) })
    ).json()) as Array<{ id: string; name: string }>;
    const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
    expect(artist, 'fixture artist must exist').toBeTruthy();

    let added = false;
    let statusPolls = 0;
    const target = { artistName: artist.name, localArtistId: artist.id };
    await page.route(`**/api/discography/artists/${artist.id}`, (route) =>
      route.fulfill({
        json: added
          ? { artistId: artist.id, lidarrId: 9, mbid: 'mb', albums: [] }
          : {
              notProvisioned: true,
              artistId: artist.id,
              artistName: artist.name,
              artistMbid: 'mb',
              candidateName: artist.name,
              provisioning: false,
            },
      }),
    );
    await page.route(`**/api/discography/artists/${artist.id}/provision`, (route) =>
      route.fulfill({
        status: 202,
        json: {
          provisioning: true,
          code: 'ARTIST_PROVISIONING',
          status: { phase: 'running', target },
        },
      }),
    );
    await page.route('**/api/discography/provisioning', (route) => {
      statusPolls++;
      // One running poll so the pending state is observable, then done.
      if (statusPolls > 1) added = true;
      return route.fulfill({
        json: added
          ? { phase: 'idle', target, lastOutcome: 'completed', lastError: null, lidarrId: 9 }
          : { phase: 'running', target, lastOutcome: null, lastError: null, lidarrId: null },
      });
    });

    await page.goto(`/library/artists/${artist.id}`);

    const add = page.getByTestId('discography-add-artist');
    await expect(add).toBeVisible();
    await expect(page.getByTestId('discography-summary')).toHaveCount(0);

    await add.click();
    await expect(page.getByTestId('discography-provisioning')).toBeVisible();

    await expect(page.getByTestId('discography-summary')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId('discography-provisioning')).toHaveCount(0);
    await expect(page.getByTestId('discography-add-artist')).toHaveCount(0);
  });
});
