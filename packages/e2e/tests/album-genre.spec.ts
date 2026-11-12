/**
 * Album page genre chip + expandable share (docs/genre-radar.md) — the real DOM
 * against the real API. The header names the album's main genre in one chip;
 * the part-to-whole split stays mounted-but-hidden until the chip is toggled.
 *
 * The fixture album carries no genre tag, so the spec seeds the same curator
 * override `artist-genre-about.spec.ts` does. Without it the chip legitimately
 * hides and every assertion below would pass vacuously.
 */
import { test, expect, type APIRequestContext } from '../helpers';
import { ADMIN, FIXTURE, bearer, openAlbumCard } from '../helpers';

async function seedGenres(request: APIRequestContext): Promise<void> {
  const login = await request.post('/api/auth/login', { data: ADMIN });
  const jwt = ((await login.json()) as { token: string }).token;
  const artists = (await (
    await request.get('/api/library/artists', { headers: bearer(jwt) })
  ).json()) as Array<{ id: string; name: string }>;
  const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
  expect(artist, 'fixture artist must exist').toBeTruthy();
  const applied = await request.post(`/api/library/artists/${artist.id}/genre`, {
    headers: bearer(jwt),
    data: { genres: 'Folclore; Chacarera; Zamba', note: 'e2e album-genre' },
  });
  expect(applied.ok()).toBe(true);
}

test('names the main genre in a chip and keeps the split behind it', async ({ page, request }) => {
  await seedGenres(request);

  await page.goto('/library');
  const distribution = page.waitForResponse(
    (r) => /\/albums\/[^/]+\/genre-distribution$/.test(new URL(r.url()).pathname) && r.ok(),
    { timeout: 15_000 },
  );
  await openAlbumCard(page, FIXTURE.album.title);
  const body = (await (await distribution).json()) as {
    primary: { taggedCount: number; slices: Array<{ genre: string; weight: number }> };
  };
  // Every track's primary is Folclore: one 100% slice, where the overlapping
  // weights the old strip drew showed three genres.
  expect(body.primary.slices).toEqual([expect.objectContaining({ genre: 'Folclore', weight: 1 })]);

  const toggle = page.getByTestId('album-genres-toggle');
  await expect(toggle).toContainText('Folclore');
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByTestId('genre-share-bar')).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByTestId('genre-share-bar')).toBeVisible();
  await expect(page.getByTestId('genre-share-folclore')).toContainText('100%');
});
