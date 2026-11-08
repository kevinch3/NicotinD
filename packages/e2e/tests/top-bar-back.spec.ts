import { test, expect, type Locator, type Page } from '../helpers';
import { ADMIN, FIXTURE, bearer, openAlbumCard } from '../helpers';

/**
 * #1770: the back arrow lives in the shell's top bar, beside the logo, and the
 * pages no longer spend a row of their own on it. Below md the bar exists only
 * to carry that arrow — a page with nothing to go back to has no bar at all.
 */
const PHONE = { width: 412, height: 915 };

async function box(l: Locator) {
  const b = await l.boundingBox();
  expect(b, 'element has a layout box').toBeTruthy();
  return b!;
}

/** The arrow is in the header, on the logo's row, with a 44px tap target. */
async function expectBackInTopBar(page: Page): Promise<number> {
  const header = page.getByTestId('app-header');
  const back = header.getByTestId('top-bar-back');
  await expect(back).toBeVisible();
  const backBox = await box(back);
  const brandBox = await box(header.getByTestId('app-brand'));
  const centre = (b: { y: number; height: number }) => b.y + b.height / 2;
  expect(Math.abs(centre(backBox) - centre(brandBox)), 'same row as the logo').toBeLessThan(3);
  expect(backBox.x, 'left of the logo').toBeLessThan(brandBox.x);
  expect(backBox.width).toBeGreaterThanOrEqual(44);
  expect(backBox.height).toBeGreaterThanOrEqual(44);
  // Exactly one back control on screen — the page's own row is gone.
  await expect(page.locator('main').getByRole('button', { name: 'Back' })).toHaveCount(0);
  const headerBox = await box(header);
  return headerBox.y + headerBox.height;
}

test.describe('top-bar back on a phone', () => {
  test.use({ viewport: PHONE });

  test('album detail: arrow beside the logo, content starts under the bar, tap goes back', async ({
    page,
  }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await expect(page.getByTestId('play-album')).toBeVisible();

    const headerBottom = await expectBackInTopBar(page);
    // The page's padding only: the 60px arrow row that used to sit here is gone.
    const cover = await box(page.getByTestId('album-cover'));
    expect(cover.y - headerBottom, 'cover starts right under the bar').toBeLessThan(32);

    await page.getByTestId('top-bar-back').click();
    await expect(page).toHaveURL(/\/library(?:[?#]|$)/);
  });

  test('artist detail: arrow beside the logo, content starts under the bar, tap goes back', async ({
    page,
  }) => {
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const albumUrl = page.url();
    await page.locator('main').getByTestId('entity-link-artist').first().click();
    await expect(page).toHaveURL(/\/library\/artists\//);
    const heading = page.locator('main h1').first();
    await expect(heading).toHaveText(FIXTURE.album.artist);

    const headerBottom = await expectBackInTopBar(page);
    const headingBox = await box(heading);
    // 20px page padding + the 80px avatar centring the name; the old arrow row
    // put it ~80px lower.
    expect(headingBox.y - headerBottom, 'header block starts right under the bar').toBeLessThan(60);

    await page.getByTestId('top-bar-back').click();
    await expect(page).toHaveURL(albumUrl);
  });

  test('a deep-linked album with no in-app history falls back to its artist', async ({
    page,
    request,
  }) => {
    const login = await request.post('/api/auth/login', { data: ADMIN });
    const jwt = ((await login.json()) as { token: string }).token;
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(jwt) })
    ).json()) as Array<{ id: string; name: string }>;
    const album = albums.find((a) => a.name === FIXTURE.album.title)!;
    expect(album, 'fixture album exists').toBeTruthy();

    await page.goto(`/library/albums/${album.id}`);
    await expect(page.getByTestId('play-album')).toBeVisible();
    await page.getByTestId('top-bar-back').click();
    await expect(page).toHaveURL(/\/library\/artists\//);
  });

  test('a settings sub-page carries the arrow; its target stays /settings', async ({ page }) => {
    await page.goto('/settings/about');
    await expect(page.getByTestId('about-settings')).toBeVisible();
    await expectBackInTopBar(page);
    await page.getByTestId('top-bar-back').click();
    await expect(page).toHaveURL(/\/settings(?:[?#]|$)/);
  });

  test('a top-level page has no bar at all — the bottom tab bar orients it', async ({ page }) => {
    await page.goto('/library');
    await expect(page.getByTestId('library-find')).toBeVisible();
    await expect(page.getByTestId('app-header')).toBeHidden();
    await expect(page.getByTestId('top-bar-back')).toHaveCount(0);
    // The strip that keeps a scrolling page out from under the status bar.
    await expect(page.getByTestId('status-bar-scrim')).toHaveCount(1);
    const find = await box(page.getByTestId('library-find'));
    expect(find.y, 'content starts at the top of the screen').toBeLessThan(32);
  });
});

test.describe('top-bar back on desktop', () => {
  test('the same arrow sits before the logo; pages without a target keep the bar as it was', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto('/library');
    await expect(page.getByTestId('app-header')).toBeVisible();
    await expect(page.getByTestId('top-bar-back')).toHaveCount(0);
    await expect(page.getByTestId('desktop-nav')).toBeVisible();

    await openAlbumCard(page, FIXTURE.album.title);
    await expectBackInTopBar(page);
    await page.getByTestId('top-bar-back').click();
    await expect(page).toHaveURL(/\/library(?:[?#]|$)/);
  });
});
