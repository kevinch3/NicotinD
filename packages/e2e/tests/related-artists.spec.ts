/**
 * Related artists (docs/related-artists.md). The e2e server runs no analysis
 * sidecar, so no fixture song carries an embedding and every artist is
 * `no-signal` — the populated row is covered by the API and component tests,
 * and this spec pins the honest empty case end to end: the page asks, hears
 * "no signal", and shows no shelf rather than an empty one.
 */
import { test, expect, type APIRequestContext } from '../helpers';
import { ADMIN, FIXTURE, bearer } from '../helpers';

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

test.describe('related artists', () => {
  test('an unanalysed artist shows no related row, and the page is unaffected', async ({
    page,
    request,
  }) => {
    const jwt = await token(request);
    const artists = (await (
      await request.get('/api/library/artists', { headers: bearer(jwt) })
    ).json()) as Array<{ id: string; name: string }>;
    const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
    expect(artist, 'fixture artist must exist').toBeTruthy();

    const related = await request.get(`/api/library/artists/${artist.id}/related`, {
      headers: bearer(jwt),
    });
    expect(related.ok()).toBe(true);
    expect(await related.json()).toEqual({ artists: [], reason: 'no-signal' });

    const asked = page.waitForResponse((r) =>
      r.url().includes(`/api/library/artists/${artist.id}/related`),
    );
    await page.goto(`/library/artists/${artist.id}`);
    await asked;
    await expect(page.getByRole('heading', { name: FIXTURE.album.artist })).toBeVisible();
    await expect(page.getByTestId('related-artists')).toHaveCount(0);
  });
});
