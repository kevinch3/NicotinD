/**
 * Genre radar (issue #222) — DOM coverage for the visualization, which the web
 * unit harness can't do (it cannot drive Angular signal inputs; see
 * genre-radar.component.spec.ts). The geometry and the component computeds are
 * unit-tested; this asserts the chart actually renders on the curation surface.
 *
 * The fixtures are silent FLACs with no genre tags, so the spec *creates* the
 * data it needs via a curator genre override (which runs a synchronous rescan).
 * Without that the chart legitimately hides and every assertion below would
 * vacuously pass.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ADMIN, FIXTURE, bearer } from '../helpers';

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

test.describe('genre radar', () => {
  test('the artist genre-fix modal charts the genre spread with a value table', async ({
    page,
    request,
  }) => {
    const jwt = await token(request);
    const artists = (await (
      await request.get('/api/library/artists', { headers: bearer(jwt) })
    ).json()) as Array<{ id: string; name: string }>;
    const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
    expect(artist, 'fixture artist must exist').toBeTruthy();

    // Give every track of theirs a multi-genre set so the radar has real axes.
    const applied = await request.post(`/api/library/artists/${artist.id}/genre`, {
      headers: bearer(jwt),
      data: { genres: 'Folclore; Chacarera; Zamba', note: 'e2e radar fixture' },
    });
    expect(applied.ok()).toBe(true);

    await page.goto(`/library/artists/${artist.id}`);
    await page.getByTestId('artist-genre-fix').click();

    const radar = page.getByTestId('genre-radar');
    await expect(radar).toBeVisible();

    // Chart and its exact-value table always ship together: a radar distorts
    // magnitude, so the numbers must be readable beside it.
    await expect(page.getByTestId('genre-radar-table')).toBeVisible();
    await expect(radar.locator('svg')).toHaveAttribute('role', 'img');
    await expect(page.getByTestId('genre-radar-caption')).toContainText('past 100%');

    // One marker per genre axis, plus the value polygon over the ring grid.
    await expect(radar.locator('svg circle')).toHaveCount(3);
    await expect(radar.locator('svg polygon')).toHaveCount(5); // 4 rings + values

    // Every genre reaches the table.
    const rows = radar.locator('[data-testid="genre-radar-table"] tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.first()).toContainText('%');

    // The correction surface it sits inside still works.
    await expect(page.getByTestId('artist-genre-input')).toBeVisible();
  });
});
