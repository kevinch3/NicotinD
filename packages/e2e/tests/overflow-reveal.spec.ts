/**
 * Names are never unreadably truncated (#1665): a name that does not fit
 * scrolls its own box far enough to show the last character, one that fits
 * never moves, and under reduced motion a tap wraps it instead. jsdom has no
 * layout, so the unit specs cannot see a real overflow; this is where the
 * real `scrollWidth`, `scrollLeft` and media queries are.
 *
 * The fixture library has no long title, and adding one would move the counts
 * other specs pin (docs/e2e.md), so the album response is rewritten to give its
 * first track one.
 */
import { test, expect, type Locator, type Page } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

const LONG = 'Muriendo De Envidia Featuring A Guest Whose Name Will Never Fit On A Phone';
const SHORT = 'Second Wind';
const PHONE = { width: 375, height: 812 };

async function openAlbumWithLongTitle(page: Page): Promise<void> {
  await page.route('**/api/library/albums/*', async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { song?: Array<Record<string, unknown>> };
    if (body.song?.[0]) body.song[0].title = LONG;
    await route.fulfill({ response: res, json: body });
  });
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await expect(page.getByTestId('play-album')).toBeVisible();
}

const rowTitle = (page: Page, title: string): Locator =>
  page
    .getByTestId('track-row')
    .filter({ hasText: title })
    .first()
    .getByTestId('track-row-title')
    .locator('p');

interface Box {
  scrollLeft: number;
  max: number;
  expanded: boolean;
  title: string | null;
}
const box = (el: Locator): Promise<Box> =>
  el.evaluate((n: HTMLElement) => ({
    scrollLeft: Math.abs(n.scrollLeft),
    max: n.scrollWidth - n.clientWidth,
    expanded: n.classList.contains('overflow-reveal-expanded'),
    title: n.getAttribute('title'),
  }));

/** Wait for a name to scroll all the way to its last character. */
async function expectFullyRevealed(el: Locator, timeout = 20_000): Promise<void> {
  await expect
    .poll(
      async () => {
        const b = await box(el);
        return b.max > 0 && b.scrollLeft >= b.max - 1;
      },
      { timeout, intervals: [100] },
    )
    .toBe(true);
}

/** The most a name scrolled while we watched it for `ms`. */
async function maxScrollOver(page: Page, el: Locator, ms: number): Promise<number> {
  let most = 0;
  for (const end = Date.now() + ms; Date.now() < end;) {
    most = Math.max(most, (await box(el)).scrollLeft);
    await page.waitForTimeout(100);
  }
  return most;
}

test.describe('overflow reveal on a touch phone (#1665)', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('a long row title scrolls to its end once it settles; a short one never moves', async ({
    page,
  }) => {
    await openAlbumWithLongTitle(page);
    const long = rowTitle(page, LONG);
    const short = rowTitle(page, SHORT);
    await expect(long).toHaveText(LONG);

    const before = await box(long);
    expect(before.max, 'the long title overflows its row').toBeGreaterThan(40);
    expect(before.title, 'the full name is on the element').toBe(LONG);
    expect((await box(short)).max, 'the short title fits').toBe(0);

    await expectFullyRevealed(long);
    // Once: it comes home and stays there.
    await expect.poll(async () => (await box(long)).scrollLeft, { timeout: 15_000 }).toBe(0);
    expect(await maxScrollOver(page, long, 3_000)).toBe(0);
    expect((await box(short)).scrollLeft).toBe(0);
  });

  test('the playing title keeps scrolling in the mini player and the sheet', async ({ page }) => {
    // Three whole passes at reading speed.
    test.setTimeout(90_000);
    await openAlbumWithLongTitle(page);
    await rowTitle(page, LONG).tap();
    const mini = page.getByTestId('player-title');
    await expect(mini).toHaveText(LONG);
    // The fixture tracks are short; hold this one so the title outlasts three passes.
    const pause = page.locator('app-player').getByRole('button', { name: 'Pause', exact: true });
    await pause.tap();
    await expect(
      page.locator('app-player').getByRole('button', { name: 'Play', exact: true }),
    ).toBeVisible();

    await expectFullyRevealed(mini);
    await expect.poll(async () => (await box(mini)).scrollLeft, { timeout: 15_000 }).toBe(0);
    // Always, not once: it goes round again.
    await expectFullyRevealed(mini);

    await mini.tap();
    const sheet = page.getByTestId('now-playing-title');
    await expect(sheet).toHaveText(LONG);
    await expectFullyRevealed(sheet);
  });

  test('under reduced motion nothing moves, and a tap wraps the name instead', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openAlbumWithLongTitle(page);
    const long = rowTitle(page, LONG);
    await expect(long).toHaveText(LONG);
    expect((await box(long)).max).toBeGreaterThan(40);
    expect(await maxScrollOver(page, long, 4_000)).toBe(0);

    await long.tap();
    const expanded = await box(long);
    expect(expanded.expanded).toBe(true);
    expect(expanded.max, 'the whole name fits once wrapped').toBe(0);
    // That tap was for reading; it did not start the track. The mini player's
    // title is empty with no current track, and an "is empty" assertion passes
    // on its first poll, so give a playback start time to render first.
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('player-title')).toBeEmpty();

    // The next one is the row's own.
    await long.tap();
    await expect(page.getByTestId('player-title')).toHaveText(LONG);
  });
});

/**
 * The home mosaic builds its faces as HTML strings on a pooled canvas, so no
 * directive reaches them; the component attaches the controller itself (#1707).
 * Every random pick is renamed so whichever tile lands on screen has a long name.
 */
const LONG_ARTIST = 'Los Hermanos Del Valle Y Su Orquesta Tropical De Medianoche';

async function openMosaicWithLongNames(page: Page): Promise<Locator> {
  await page.route(/\/api\/library\/random(\?|$)/, async (route) => {
    const res = await route.fetch();
    const songs = (await res.json()) as Array<Record<string, unknown>>;
    for (const s of songs) Object.assign(s, { title: LONG, artist: LONG_ARTIST });
    await route.fulfill({ response: res, json: songs });
  });
  await page.goto('/');
  const tiles = page
    .locator('[data-testid="mosaic-tile"][data-tile-kind="song"]')
    .filter({ hasText: LONG });
  await expect(tiles.first()).toBeVisible({ timeout: 10_000 });
  // A tile wholly on screen and clear of the bottom chrome, whose centre and name are its own.
  const index = await tiles.evaluateAll((els) =>
    els.findIndex((el) => {
      const r = el.getBoundingClientRect();
      if (r.x < 0 || r.y < 0 || r.right > innerWidth || r.bottom > innerHeight - 140) return false;
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (hit?.closest('[data-testid="mosaic-tile"]') !== el) return false;
      // The name is what gets tapped: nothing (the Shelves | Mosaic switch) may sit over it.
      const name = el.querySelector('b.mosaic-name')?.getBoundingClientRect();
      if (!name) return false;
      const onName = document.elementFromPoint(name.x + name.width / 2, name.y + name.height / 2);
      return onName?.closest('[data-testid="mosaic-tile"]') === el;
    }),
  );
  expect(index, 'a renamed song tile is fully on screen').toBeGreaterThanOrEqual(0);
  // Pin the element itself. `tiles.nth(index)` re-resolves on every use, and the
  // field re-renders its pooled faces, so it could hover one tile and then watch
  // another — which never moves.
  await tiles.nth(index).evaluate((el) => el.setAttribute('data-e2e-picked', ''));
  return page.locator('[data-e2e-picked]');
}

test.describe('overflow reveal on a mosaic tile, touch (#1707)', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('a long song and artist each scroll to their end once the field is still', async ({
    page,
  }) => {
    const tile = await openMosaicWithLongNames(page);
    const title = tile.locator('b.mosaic-name');
    const artist = tile.locator('span.mosaic-name');
    await expect(title).toHaveText(LONG);
    await expect(artist).toHaveText(LONG_ARTIST);
    for (const [name, full] of [
      [title, LONG],
      [artist, LONG_ARTIST],
    ] as const) {
      const before = await box(name);
      expect(before.max, 'one line now, so the name overflows sideways').toBeGreaterThan(40);
      expect(before.title, 'the full name is on the element').toBe(full);
    }
    await Promise.all([expectFullyRevealed(title, 40_000), expectFullyRevealed(artist, 40_000)]);
    await expect.poll(async () => (await box(title)).scrollLeft, { timeout: 30_000 }).toBe(0);
  });

  test('under reduced motion a tap on the name wraps it and does not start the radio', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    const tile = await openMosaicWithLongNames(page);
    const title = tile.locator('b.mosaic-name');
    await expect(title).toHaveText(LONG);
    const before = await page.getByTestId('player-title').textContent();
    expect(await maxScrollOver(page, title, 3_000)).toBe(0);

    await title.tap();
    await expect.poll(async () => (await box(title)).expanded).toBe(true);
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('player-title')).toHaveText(before ?? '');
  });
});

test.describe('overflow reveal with a mouse (#1665)', () => {
  test.use({ viewport: { width: 800, height: 900 } });

  test('a long row title scrolls while hovered, and only then', async ({ page }) => {
    await openAlbumWithLongTitle(page);
    const long = rowTitle(page, LONG);
    // Squeeze the row so the title overflows at a desktop width too.
    await long.evaluate((n: HTMLElement) => (n.style.maxWidth = '160px'));
    expect((await box(long)).max).toBeGreaterThan(40);
    // Park the pointer off the rows: it rests where the album card was
    // clicked, and once the back row left the page (#1770) that spot is a row.
    await page.mouse.move(0, 0);
    expect(await maxScrollOver(page, long, 3_000), 'no hover, no motion').toBe(0);

    await long.hover();
    await expectFullyRevealed(long);
    await page.mouse.move(0, 0);
    await expect.poll(async () => (await box(long)).scrollLeft, { timeout: 10_000 }).toBe(0);
    expect(await maxScrollOver(page, long, 3_000)).toBe(0);
  });

  test('a mosaic tile scrolls its long name while the tile is hovered (#1707)', async ({
    page,
  }) => {
    // The reveal is allowed 40 s below; the default 30 s budget would end the test first.
    test.setTimeout(60_000);
    const tile = await openMosaicWithLongNames(page);
    const title = tile.locator('b.mosaic-name');
    expect((await box(title)).max).toBeGreaterThan(40);
    expect(await maxScrollOver(page, title, 3_000), 'no hover, no motion').toBe(0);

    const r = (await tile.boundingBox())!;
    await page.mouse.move(r.x + r.width / 2, r.y + r.height / 3);
    await expectFullyRevealed(title, 40_000);
  });
});
