/**
 * Artist origin (docs/artist-origin.md) — DOM coverage for the artist-page
 * origin line. The fixtures carry no MBID tags, so no origin resolves on its
 * own; the spec *creates* the data through the curator PUT (the same write the
 * in-page picker issues) and asserts the flag line renders.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ADMIN, FIXTURE, bearer } from '../helpers';

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

test.describe('artist origin', () => {
  test('a curator-set origin renders as the flag line on the artist page', async ({
    page,
    request,
  }) => {
    const jwt = await token(request);
    const artists = (await (
      await request.get('/api/library/artists', { headers: bearer(jwt) })
    ).json()) as Array<{ id: string; name: string }>;
    const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
    expect(artist, 'fixture artist must exist').toBeTruthy();

    const applied = await request.put(`/api/library/artists/${artist.id}/origin`, {
      headers: bearer(jwt),
      data: { country: 'AR' },
    });
    expect(applied.ok()).toBe(true);

    await page.goto(`/library/artists/${artist.id}`);
    const origin = page.getByTestId('artist-origin');
    await expect(origin).toBeVisible();
    await expect(origin).toContainText('Argentina');

    // Same write, second surface: the filter facets now carry the country.
    const facets = (await (
      await request.get('/api/library/origin-countries', { headers: bearer(jwt) })
    ).json()) as { countries: Array<{ country: string; artists: number }> };
    expect(facets.countries.some((c) => c.country === 'AR')).toBe(true);
  });
});
