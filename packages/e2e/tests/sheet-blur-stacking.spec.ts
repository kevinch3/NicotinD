import { test, expect, type Page } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

/**
 * The blur and stacking contract (#1649, docs/design-patterns.md). With Now
 * Playing open, its top band (safe area, grab handle, close chevron) showed
 * blurred on an iPhone PWA: on iOS WebKit a `backdrop-filter` layer paints over
 * a higher z-index surface regardless (#1522). Chromium does not model that
 * misorder, so this asserts the precondition instead — no blurred layer is
 * displayed under the band at all, on a scrolling page (the header) and on
 * the mosaic home (the rim and the Shelves | Mosaic switch).
 */
const PHONE = { width: 412, height: 915 };

async function startPlayback(page: Page): Promise<void> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
}

async function openSheet(page: Page): Promise<void> {
  await page.getByTestId('player-title').click();
  const handle = page.getByTestId('now-playing-drag-handle');
  await expect(handle).toBeInViewport();
  // The sheet slides up, and `toBeInViewport` passes on its first pixel: wait
  // for the band to come to rest at the top, or it is measured mid-screen.
  let last = Number.NaN;
  await expect
    .poll(async () => {
      const y = (await handle.boundingBox())?.y ?? Number.NaN;
      const settled = y === last && y < PHONE.height / 4;
      last = y;
      return settled;
    })
    .toBe(true);
}

/**
 * Every displayed, visible element outside the sheet whose computed
 * backdrop-filter is not `none` and whose box meets the drag handle's. A
 * `querySelectorAll` walk, not `elementsFromPoint`: the mosaic rim is
 * `pointer-events: none`, which hit-testing skips.
 */
function blurredUnderHandle(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const handle = document.querySelector('[data-testid="now-playing-drag-handle"]')!;
    const band = handle.getBoundingClientRect();
    const sheet = document.querySelector('app-now-playing');
    const hits: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('body *')) {
      if (sheet?.contains(el)) continue;
      const style = getComputedStyle(el);
      const filter =
        style.backdropFilter ||
        (style as unknown as { webkitBackdropFilter?: string }).webkitBackdropFilter ||
        'none';
      if (filter === 'none') continue;
      if (style.visibility === 'hidden' || el.getClientRects().length === 0) continue;
      const r = el.getBoundingClientRect();
      const meets =
        r.left < band.right && r.right > band.left && r.top < band.bottom && r.bottom > band.top;
      if (!meets) continue;
      const id = el.dataset['testid'] ?? el.tagName.toLowerCase();
      hits.push(`${id} (${filter})`);
    }
    return hits;
  });
}

test.describe('sheet blur stacking (#1649)', () => {
  test.use({ viewport: PHONE });

  test('no blurred layer sits under the open sheet top band on a scrolling page', async ({
    page,
  }, testInfo) => {
    await startPlayback(page);
    // The header is displayed on /library at every width: the candidate layer.
    await expect(page.locator('header[data-top-chrome]')).toBeVisible();
    await openSheet(page);

    expect(await blurredUnderHandle(page)).toEqual([]);

    // A visual record of the band for review, not a baseline: its text renders
    // through the host's fonts, which the chromium project does not pin.
    const shot = await page
      .getByTestId('now-playing-drag-handle')
      .screenshot({ animations: 'disabled' });
    await testInfo.attach('now-playing-top-band', { body: shot, contentType: 'image/png' });
  });

  test('on the mosaic home the rim blur stands down while the sheet covers it', async ({
    page,
  }) => {
    await startPlayback(page);
    // Client-side navigation keeps the playback the sheet opens onto.
    await page.locator('nav[data-bottom-chrome]').getByRole('link', { name: 'Home' }).click();
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    const rim = page.getByTestId('mosaic-rim');
    await expect(rim).toHaveCSS('visibility', 'visible', { timeout: 10_000 });

    await openSheet(page);
    expect(await blurredUnderHandle(page)).toEqual([]);
    await expect(rim).toHaveCSS('visibility', 'hidden');
    await expect(page.getByTestId('mosaic-home')).toHaveClass(/\bmosaic-covered\b/);

    // Sample every frame of the slide away: the rim must not be drawn while the
    // band is still on screen (it used to fade back in under it). Keyed on the
    // band's position, not on wall time, so a slow runner cannot flake it.
    await page.evaluate(() => {
      const w = window as unknown as { __rimUnderBand: number[]; __bandGone: boolean };
      w.__rimUnderBand = [];
      w.__bandGone = false;
      const handle = document.querySelector('[data-testid="now-playing-drag-handle"]')!;
      const rimEl = document.querySelector('[data-testid="mosaic-rim"]')!;
      const tick = (): void => {
        const top = handle.getBoundingClientRect().top;
        if (top >= window.innerHeight) {
          w.__bandGone = true;
          return;
        }
        const s = getComputedStyle(rimEl);
        if (s.visibility !== 'hidden' && Number(s.opacity) > 0) w.__rimUnderBand.push(top);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await page.getByTestId('now-playing-close').click();
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __bandGone: boolean }).__bandGone))
      .toBe(true);
    expect(
      await page.evaluate(() => (window as unknown as { __rimUnderBand: number[] }).__rimUnderBand),
    ).toEqual([]);
    await expect(page.getByTestId('mosaic-home')).not.toHaveClass(/\bmosaic-covered\b/);
    await expect(rim).toHaveCSS('visibility', 'visible');
  });
});
