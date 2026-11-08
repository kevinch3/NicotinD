import { test, expect, FIXTURE, openAlbumCard, type Page } from '../helpers';

/**
 * The slim Now Playing chrome (#1715, #1716 — the owner's layout B): the title
 * stands alone, Like leads the transport row and the radio control closes it,
 * the ⋯ sits on the artwork like a Mosaic tile, and a still long-press on the
 * artwork opens the same menu. A hold that moves is a swipe: it skips.
 */
test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

async function openSheet(page: Page): Promise<void> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-cover')).toBeInViewport();
  // The sheet slides up on a 300ms transform: measure only once it has stopped.
  let last = '';
  await expect
    .poll(async () => {
      const b = await page.getByTestId('now-playing-cover').boundingBox();
      const now = b ? `${Math.round(b.x)},${Math.round(b.y)}` : '';
      const settled = now !== '' && now === last;
      last = now;
      return settled;
    })
    .toBe(true);
}

/** A touch held on the cover's centre for `ms` (Playwright's touchscreen has no
 *  hold), optionally travelling `dx` first. Returns after the release. */
async function touchHold(page: Page, ms: number, dx = 0): Promise<void> {
  const cover = (await page.getByTestId('now-playing-cover-art').boundingBox())!;
  const x = cover.x + cover.width / 2;
  const y = cover.y + cover.height / 2;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
  for (let i = 1; dx && i <= 10; i++) {
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: x + (dx * i) / 10, y }],
    });
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(ms);
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await cdp.detach();
}

test.describe('Now Playing chrome (layout B)', () => {
  test('the title stands alone; Like and radio flank the transport; ⋯ is on the art', async ({
    page,
  }) => {
    await openSheet(page);
    const titleRow = page.getByTestId('now-playing-title-row');
    await expect(titleRow.locator('button')).toHaveCount(0);
    await expect(page.getByTestId('now-playing-report')).toHaveCount(0);
    await expect(page.getByTestId('now-playing-info')).toHaveCount(0);

    const like = (await page.getByTestId('now-playing-like').boundingBox())!;
    const prev = (await page.getByTestId('now-playing-prev').boundingBox())!;
    const next = (await page.getByTestId('now-playing-next').boundingBox())!;
    const radio = (await page.getByTestId('now-playing-radio').boundingBox())!;
    expect(like.x + like.width).toBeLessThanOrEqual(prev.x);
    expect(radio.x).toBeGreaterThanOrEqual(next.x + next.width);
    // One row, and both new controls are full 44px targets.
    expect(Math.abs(like.y + like.height / 2 - (radio.y + radio.height / 2))).toBeLessThan(2);
    for (const b of [like, radio]) {
      expect(b.width).toBeGreaterThanOrEqual(44);
      expect(b.height).toBeGreaterThanOrEqual(44);
    }
    // The pill row under the transport is gone.
    await expect(page.locator('app-radio-chip')).toHaveCount(0);

    const toggle = page.getByTestId('now-playing-menu-toggle');
    const cover = (await page.getByTestId('now-playing-cover').boundingBox())!;
    const t = (await toggle.boundingBox())!;
    expect(t.y).toBeGreaterThanOrEqual(cover.y);
    expect(t.y + t.height).toBeLessThanOrEqual(cover.y + cover.height);
    await toggle.click();
    const menu = page.getByTestId('now-playing-menu');
    await expect(menu.getByTestId('track-action-Song info')).toBeVisible();
    await expect(menu.getByTestId('track-action-Report this track')).toBeVisible();
  });

  test('a still long-press on the artwork opens the menu; a moving one skips', async ({ page }) => {
    await openSheet(page);
    const menu = page.getByTestId('now-playing-menu');

    await touchHold(page, 700);
    await expect(menu.getByTestId('track-action-Song info')).toBeVisible();
    // The release after the hold must not close the menu it opened.
    await page.waitForTimeout(300);
    await expect(menu.getByTestId('track-action-Song info')).toBeVisible();
    await page.evaluate(() => document.body.click());
    await expect(menu.getByTestId('track-action-Song info')).toHaveCount(0);

    const before = await page.getByTestId('now-playing-title').textContent();
    await touchHold(page, 600, -140);
    await expect(page.getByTestId('now-playing-title')).not.toHaveText(before ?? '');
    await expect(menu.getByTestId('track-action-Song info')).toHaveCount(0);
  });

  test('the radio icon turns radio on in one tap, then opens the dial', async ({ page }) => {
    await openSheet(page);
    const radio = page.getByTestId('now-playing-radio');
    await expect(radio).toHaveAttribute('aria-pressed', 'false');
    await radio.click();
    await expect(radio).toHaveAttribute('aria-pressed', 'true');
    await radio.click();
    await expect(page.getByTestId('radio-variety')).toBeVisible();
    // The dial carries the off switch.
    await page.getByTestId('np-radio-switch').click();
    await expect(page.getByTestId('now-playing-radio')).toHaveAttribute('aria-pressed', 'false');
  });
});
