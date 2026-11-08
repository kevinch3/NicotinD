import { test, expect, type Locator, type Page } from '../helpers';
import { FIXTURE, openAlbumCard } from '../helpers';

/**
 * #1714: on the owner's iPhone the Now Playing ⋯ menu flipped up from beside
 * the title and clamped to an 8px margin — its first items under the status
 * bar, the rest far from the thumb. On a phone every menu is now a bottom action
 * sheet (`menuPresentation`, docs/design-patterns.md "Reachable menus"); wider
 * viewports keep the anchored popover, now bounded by the status bar too.
 *
 * Chromium has no notch, so `--safe-top` (styles.css, read by
 * `measureTopChromeInset`) stands in for `env(safe-area-inset-top)` here.
 */
const PHONE = { width: 390, height: 844 };
const LANDSCAPE_PHONE = { width: 844, height: 390 };
/** An iPhone status bar with a notch. */
const SAFE_TOP = 47;

async function fakeNotch(page: Page): Promise<void> {
  await page.addInitScript((px) => {
    document.addEventListener('DOMContentLoaded', () => {
      const style = document.createElement('style');
      style.textContent = `:root { --safe-top: ${px}px !important; }`;
      document.head.appendChild(style);
    });
  }, SAFE_TOP);
}

async function playAlbum(page: Page): Promise<void> {
  await page.goto('/library');
  await openAlbumCard(page, FIXTURE.album.title);
  await page.getByTestId('play-album').click();
  await expect(page.getByTestId('player-title')).toBeVisible();
}

async function openNowPlayingMenu(page: Page): Promise<Locator> {
  await page.getByTestId('player-title').click();
  await expect(page.getByTestId('now-playing-heading')).toBeVisible();
  await page.getByTestId('now-playing-menu-toggle').click();
  const menu = page.getByTestId('now-playing-menu');
  await expect(menu).toBeVisible();
  return menu;
}

interface Geometry {
  presentation: string | undefined;
  vw: number;
  vh: number;
  safeTop: number;
  /** Top of the visible bottom chrome; the viewport bottom where none shows. */
  chromeTop: number;
  panelTop: number;
  panelBottom: number;
  scrolls: boolean;
  items: { label: string; top: number; bottom: number; left: number; right: number }[];
}

function measure(menu: Locator): Promise<Geometry> {
  return menu.evaluate((el: HTMLElement) => {
    const vh = window.innerHeight;
    // Now Playing paints over the chrome: under it there is nothing to clear.
    const covered = !!el.closest('[data-covers-chrome]');
    const tops = covered
      ? []
      : Array.from(document.querySelectorAll('[data-bottom-chrome]'))
          .map((c) => c.getBoundingClientRect())
          .filter((r) => r.height > 0 && r.top < vh)
          .map((r) => r.top);
    const box = el.getBoundingClientRect();
    return {
      presentation: el.dataset['presentation'],
      vw: window.innerWidth,
      vh,
      safeTop: parseFloat(
        getComputedStyle(document.documentElement).getPropertyValue('--safe-top'),
      ),
      chromeTop: tops.length ? Math.min(...tops) : vh,
      panelTop: box.top,
      panelBottom: box.bottom,
      scrolls: el.scrollHeight > el.clientHeight + 1,
      items: Array.from(el.querySelectorAll('button')).map((b) => {
        const r = b.getBoundingClientRect();
        return {
          label: (b.textContent ?? '').trim(),
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
        };
      }),
    };
  });
}

/**
 * Every item on screen, below the notch, above the chrome — and the sheet on
 * the thumb's edge. Retried: the mini player slides in on a 300ms transform
 * transition after Play, and the sheet re-measures when it settles.
 */
async function expectReachableSheet(menu: Locator): Promise<Geometry> {
  let g!: Geometry;
  await expect(async () => {
    g = await measure(menu);
    checkSheet(g);
  }).toPass({ timeout: 5_000 });
  return g;
}

function checkSheet(g: Geometry): void {
  expect(g.safeTop, 'the fake notch is in force').toBe(SAFE_TOP);
  expect(g.items.length, 'the song menu has its full action set').toBeGreaterThanOrEqual(10);
  for (const item of g.items) {
    expect(item.top, `"${item.label}" is below the status bar`).toBeGreaterThanOrEqual(g.safeTop);
    expect(item.bottom, `"${item.label}" is above the bottom chrome`).toBeLessThanOrEqual(
      g.chromeTop + 1,
    );
    expect(item.left, `"${item.label}" starts on screen`).toBeGreaterThanOrEqual(0);
    expect(item.right, `"${item.label}" ends on screen`).toBeLessThanOrEqual(g.vw);
    expect(item.bottom - item.top, `"${item.label}" is a 44px touch target`).toBeGreaterThanOrEqual(
      43.5,
    );
  }
  // Reachable by construction: the sheet rises from the edge the thumb rests
  // on, wherever the trigger was. The anchored popover hung off its trigger.
  expect(g.presentation).toBe('sheet');
  expect(
    Math.abs(g.panelBottom - g.chromeTop),
    'the sheet sits on the bottom edge',
  ).toBeLessThanOrEqual(1);
  expect(g.scrolls, 'every item shows without scrolling').toBe(false);
}

test.describe('track menus are reachable on a phone (#1714)', () => {
  test.use({ viewport: PHONE });
  test.beforeEach(async ({ page }) => fakeNotch(page));

  test('the Now Playing ⋯ menu is a bottom sheet on the screen edge', async ({ page }) => {
    await playAlbum(page);
    const menu = await openNowPlayingMenu(page);
    const g = await expectReachableSheet(menu);
    // Inside Now Playing nothing covers the bottom: the sheet goes to the edge.
    expect(g.chromeTop).toBe(g.vh);

    // The backdrop closes it, and is nobody else's tap.
    await page.getByTestId('menu-sheet-backdrop').click({ position: { x: 20, y: 80 } });
    await expect(menu).toHaveCount(0);
    await expect(page.getByTestId('now-playing-heading')).toBeVisible();
  });

  test('a track row near the bottom of a list opens the sheet above the player', async ({
    page,
  }) => {
    await playAlbum(page);
    const last = page.getByTestId('track-row').last();
    await last.evaluate((el) => el.scrollIntoView({ block: 'end' }));
    await last.getByTestId('track-row-menu-toggle').click();
    const menu = last.getByTestId('track-row-menu');
    await expect(menu).toBeVisible();
    const g = await expectReachableSheet(menu);
    expect(g.chromeTop, 'the mini player is up').toBeLessThan(g.vh);

    // An item still works from the sheet.
    await last.getByTestId('track-action-Song info').click();
    await expect(page.getByTestId('track-info-sheet')).toBeVisible();
  });

  test('a track row near the top of a list opens the same sheet', async ({ page }) => {
    await playAlbum(page);
    const first = page.getByTestId('track-row').first();
    await first.evaluate((el) => el.scrollIntoView({ block: 'start' }));
    await first.getByTestId('track-row-menu-toggle').click();
    const menu = first.getByTestId('track-row-menu');
    await expect(menu).toBeVisible();
    await expectReachableSheet(menu);
  });

  test('every item is translated in a Spanish UI', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('nicotind-lang', 'es'));
    await playAlbum(page);
    const menu = await openNowPlayingMenu(page);
    for (const [label, spanish] of [
      ['Add to queue', 'Añadir a la cola'],
      ['Play next', 'Reproducir a continuación'],
      ['Start radio', 'Iniciar radio'],
      ['Go to artist', 'Ir al artista'],
      ['Go to album', 'Ir al álbum'],
      ['Add to playlist', 'Añadir a una lista'],
      ['Song info', 'Info de la canción'],
      ["Don't recommend this", 'No recomendar esto'],
      ['Report this track', 'Reportar esta canción'],
    ]) {
      await expect(menu.getByTestId(`track-action-${label}`)).toHaveText(spanish);
    }
    // No item is left in English, and no key leaks as its dotted name.
    const texts = (await measure(menu)).items.map((i) => i.label);
    for (const english of ['Add to queue', 'Play next', 'Go to', 'Song info', "Don't recommend"]) {
      expect(texts.join(' | ')).not.toContain(english);
    }
    expect(texts.join(' | ')).not.toMatch(/\bsong\.|report\./);
  });
});

// Wider than the phone breakpoint the anchored popover stays — but a 12-item
// menu on a 390px-tall landscape phone used to clamp to y=8 (under the notch)
// and run on under the player. It now scrolls inside the band between the two.
test.describe('the popover stays inside the band on a landscape phone (#1714)', () => {
  test.use({ viewport: LANDSCAPE_PHONE });
  test.beforeEach(async ({ page }) => fakeNotch(page));

  test('a track-row popover is bounded by the notch and the player', async ({ page }) => {
    await playAlbum(page);
    const first = page.getByTestId('track-row').first();
    await first.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await first.getByTestId('track-row-menu-toggle').click();
    const menu = first.getByTestId('track-row-menu');
    await expect(menu).toBeVisible();

    let g!: Geometry;
    await expect(async () => {
      g = await measure(menu);
      expect(g.presentation).toBe('popover');
      expect(g.panelTop, 'below the status bar').toBeGreaterThanOrEqual(g.safeTop);
      expect(g.panelBottom, 'above the player').toBeLessThanOrEqual(g.chromeTop + 1);
    }).toPass({ timeout: 5_000 });
    expect(g.scrolls, 'a menu taller than the band scrolls inside it').toBe(true);

    // Every item is reachable: scrolled to, it lands inside the panel.
    const items = menu.locator('button');
    const count = await items.count();
    expect(count).toBeGreaterThanOrEqual(10);
    for (let i = 0; i < count; i++) {
      const item = items.nth(i);
      await item.scrollIntoViewIfNeeded();
      const box = (await item.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(g.panelTop - 1);
      expect(box.y + box.height).toBeLessThanOrEqual(g.panelBottom + 1);
    }
  });
});
