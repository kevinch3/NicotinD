/**
 * No placeholder flash between two covers on a skip (#1653). The player bar and
 * the Now Playing sheet swap their cover's `src` in place; the gradient
 * placeholder used to paint for the whole fetch. With `holdPrevious` the last
 * loaded cover stays up until the next one lands.
 *
 * Only one fixture album has art, and every track on it shares one cover id —
 * so a skip would not change `src` at all. The album response gives track 2 its
 * own cover id, served (late, on purpose) with the real cover's bytes.
 */
import { test, expect, type Page } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

const SLOW_ID = 'e2e-slow-cover';
const DELAY_MS = 1500;

async function playWithSlowSecondCover(page: Page): Promise<() => void> {
  let realCoverId = '';
  await page.route('**/api/library/albums/*', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { song?: Array<{ coverArt?: string }> };
    const songs = body.song ?? [];
    realCoverId = songs[0]?.coverArt ?? '';
    if (songs[1]) songs[1].coverArt = SLOW_ID;
    await route.fulfill({ response: res, json: body });
  });
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  await page.route(`**/api/cover/${SLOW_ID}?*`, async (route) => {
    await Promise.race([gate, new Promise((r) => setTimeout(r, DELAY_MS * 4))]);
    const url = route.request().url().replace(SLOW_ID, realCoverId);
    await route.fulfill({ response: await route.fetch({ url }) });
  });
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  return () => release();
}

/** The gradient placeholder of the cover-art host `scope`. */
const placeholderOf = (page: Page, scope: string) =>
  page.locator(`[data-testid="${scope}"] [style*="gradient"]`);
const imageOf = (page: Page, scope: string) =>
  page.locator(`[data-testid="${scope}"] img:not([data-testid="cover-art-held"])`);

test.describe('cover art holds the previous image on a skip (#1653)', () => {
  test('player bar: no placeholder while the next cover loads', async ({ page }) => {
    const release = await playWithSlowSecondCover(page);
    const scope = 'player-cover-art';
    await expect(imageOf(page, scope)).toHaveJSProperty('complete', true);
    await expect(placeholderOf(page, scope)).toHaveCount(0);

    await page.getByTestId('player-next').click();
    await expect(
      page.locator(`[data-testid="${scope}"] [data-testid="cover-art-held"]`),
    ).toBeVisible();
    await expect(placeholderOf(page, scope)).toHaveCount(0);

    release();
    await expect(
      page.locator(`[data-testid="${scope}"] [data-testid="cover-art-held"]`),
    ).toHaveCount(0);
    await expect(placeholderOf(page, scope)).toHaveCount(0);
  });

  test('Now Playing sheet: no placeholder while the next cover loads', async ({ page }) => {
    const release = await playWithSlowSecondCover(page);
    await page.getByTestId('player-title').click();
    await expect(page.getByTestId('now-playing-heading')).toBeVisible();
    const scope = 'now-playing-cover-art';
    await expect(imageOf(page, scope)).toHaveJSProperty('complete', true);
    await expect(placeholderOf(page, scope)).toHaveCount(0);

    await page.getByTestId('now-playing-next').click();
    await expect(
      page.locator(`[data-testid="${scope}"] [data-testid="cover-art-held"]`),
    ).toBeVisible();
    await expect(placeholderOf(page, scope)).toHaveCount(0);

    release();
    await expect(
      page.locator(`[data-testid="${scope}"] [data-testid="cover-art-held"]`),
    ).toHaveCount(0);
    await expect(placeholderOf(page, scope)).toHaveCount(0);
  });
});
