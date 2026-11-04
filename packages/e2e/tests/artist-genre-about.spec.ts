/**
 * Artist page genre headline + About block (#1572) — the real DOM against the
 * real API. The unit specs cover `headlineGenres` and the share bar in
 * isolation; this asserts the server's `primary` share reaches the header chips
 * and that the About block's body is mounted-but-hidden until toggled.
 *
 * The fixture artist carries no genre tag, so the spec seeds one via a curator
 * override — the same genres `genre-radar.spec.ts` seeds, so the two specs agree
 * on the artist's state whichever runs first. Without it, the chips and chart
 * legitimately hide and every assertion below would pass vacuously.
 */
import { test, expect, type APIRequestContext } from '../helpers';
import { ADMIN, FIXTURE, bearer } from '../helpers';

async function seedGenres(request: APIRequestContext): Promise<string> {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  const jwt = ((await login.json()) as { token: string }).token;
  const artists = (await (
    await request.get('/api/library/artists', { headers: bearer(jwt) })
  ).json()) as Array<{ id: string; name: string }>;
  const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
  expect(artist, 'fixture artist must exist').toBeTruthy();

  const applied = await request.post(`/api/library/artists/${artist.id}/genre`, {
    headers: bearer(jwt),
    data: { genres: 'Folclore; Chacarera; Zamba', note: 'e2e artist-genre-about' },
  });
  expect(applied.ok()).toBe(true);
  return artist.id;
}

test('names the primary genre in the header and keeps the split behind About', async ({
  page,
  request,
}) => {
  const artistId = await seedGenres(request);

  const distribution = page.waitForResponse(
    (r) => r.url().includes(`/artists/${artistId}/genre-distribution`) && r.ok(),
    { timeout: 10_000 },
  );
  await page.goto(`/library/artists/${artistId}`);
  const body = (await (await distribution).json()) as {
    primary: { taggedCount: number; slices: Array<{ genre: string; weight: number }> };
  };
  // Every track's primary is Folclore, so the share is one 100% slice — the
  // overlapping weights would have shown three genres here.
  expect(body.primary.slices).toEqual([expect.objectContaining({ genre: 'Folclore', weight: 1 })]);

  await expect(page.getByTestId('artist-headline-genre')).toHaveText(['Folclore']);
  await expect(page.locator('app-genre-distribution-strip')).toHaveCount(0);

  const toggle = page.getByTestId('artist-about-toggle');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('genre-share-bar')).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('genre-share-bar')).toBeVisible();
  await expect(page.getByTestId('genre-share-folclore')).toContainText('100%');
});
