/**
 * Curator triage (docs/curator-triage.md) — DOM coverage for the round the
 * library's "decisions waiting" card links into. The spec seeds a prose flag
 * through the real curator endpoint (no typed `case_kind`/options), which
 * `flagToCase` turns into exactly one option, "Mark handled" (a `resolve-only`
 * effect) — the simplest path to a green round.
 */
import { test, expect, type APIRequestContext } from '@playwright/test';
import { ADMIN, FIXTURE, bearer } from '../helpers';

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

test.describe('curator triage', () => {
  test('a curator works a triage round from the library view', async ({ page, request }) => {
    const jwt = await token(request);

    const artists = (await (
      await request.get('/api/library/artists', { headers: bearer(jwt) })
    ).json()) as Array<{ id: string; name: string }>;
    const artist = artists.find((a) => a.name === FIXTURE.album.artist)!;
    expect(artist, 'fixture artist must exist').toBeTruthy();

    const flagged = await request.post('/api/library/review-flags', {
      headers: bearer(jwt),
      data: { targetKind: 'artist', targetId: artist.id, reason: 'e2e: verify artist credit' },
    });
    expect(flagged.ok()).toBe(true);

    await page.goto('/library');
    const entry = page.getByTestId('curate-entry');
    await expect(entry).toBeVisible();
    await entry.click();

    await expect(page).toHaveURL(/\/library\/curate$/);
    const card = page.getByTestId('case-card');
    await expect(card).toBeVisible();

    await page.getByTestId('case-option').first().click();

    await expect(page.getByTestId('curate-done')).toBeVisible();
  });
});
