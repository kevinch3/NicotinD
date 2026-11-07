/**
 * Multi-artist credits in the Now Playing sheet (#1655): each linked name opens
 * ITS OWN artist page. The sheet used to answer a followed link by navigating to
 * the primary artist as well, and that second navigation won — so the 2nd and
 * 3rd credits both opened the 1st. The unit harness cannot render the nested
 * links (docs/web-ui.md, signal inputs), so the clicks are pinned here.
 *
 * The fixture library has no joint credit, and adding one would move the counts
 * other specs pin (docs/e2e.md). The album response is rewritten instead so its
 * first track credits three REAL fixture artists — the artist pages it lands on
 * are the server's own.
 */
import { test, expect, type APIRequestContext, type Page } from '../helpers';
import { ADMIN, FIXTURE, bearer, openAlbumCard } from '../helpers';

/** The `request` fixture carries no auth — log in explicitly (see docs/e2e.md). */
async function token(request: APIRequestContext): Promise<string> {
  const res = await request.post('/api/auth/login', { data: ADMIN });
  return ((await res.json()) as { token: string }).token;
}

type Credit = { id: string; name: string; role: 'primary' | 'featuring' };

async function fixtureCredits(request: APIRequestContext): Promise<Credit[]> {
  const artists = (await (
    await request.get('/api/library/artists', { headers: bearer(await token(request)) })
  ).json()) as Array<{ id: string; name: string }>;
  const pick = (name: string) => {
    const hit = artists.find((a) => a.name === name);
    expect(hit, `fixture artist ${name}`).toBeTruthy();
    return hit!;
  };
  return [
    { ...pick(FIXTURE.album.artist), role: 'primary' },
    { ...pick(FIXTURE.single.artist), role: 'primary' },
    { ...pick(FIXTURE.proposalPair.artist), role: 'featuring' },
  ];
}

/** Play the fixture album with every track credited to `credits`, then open the sheet. */
async function openSheetWithCredits(page: Page, credits: Credit[]): Promise<void> {
  await page.route('**/api/library/albums/*', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { song?: Array<Record<string, unknown>> };
    for (const s of body.song ?? []) s.artists = credits;
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();
}

test.describe('Now Playing — multi-artist credit links (#1655)', () => {
  for (const index of [1, 2, 0]) {
    test(`credit #${index + 1} opens its own artist page`, async ({ page, request }) => {
      const credits = await fixtureCredits(request);
      await openSheetWithCredits(page, credits);

      const links = page.locator('app-now-playing-cover-art [data-testid="entity-link-artist"]');
      await expect(links).toHaveText(credits.map((c) => c.name));

      await links.nth(index).click();

      const target = credits[index];
      await expect(page).toHaveURL(new RegExp(`/library/artists/${target.id}$`));
      await expect(page.locator('h1.page-title')).toHaveText(target.name);
      // Still this artist after a settle window: the bug was a second, later
      // navigation to the primary artist overriding the link (networkidle never
      // fires here — the player holds a socket open).
      await page.waitForTimeout(750);
      await expect(page).toHaveURL(new RegExp(`/library/artists/${target.id}$`));
      await expect(page.getByTestId('now-playing-heading')).not.toBeInViewport();
    });
  }
});
