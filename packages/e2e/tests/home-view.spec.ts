import { test, expect } from '../helpers';
import type { Page } from '@playwright/test';

async function boxOf(page: Page, testId: string) {
  const box = await page.getByTestId(testId).boundingBox();
  expect(box, `${testId} has a box`).not.toBeNull();
  return box!;
}

async function toShelves(page: Page) {
  await page.getByTestId('home-view-shelves').click();
  await expect(page.getByTestId('radio-landing')).toBeVisible();
}

/**
 * The home view switch (#1300): Shelves | Mosaic in the top-left corner of the
 * home, remembered per user, and only the chosen view's data is ever
 * requested. The default is the mosaic, which `mosaic-home.spec.ts` covers;
 * this spec exercises the switch and puts the shared admin back on it after.
 */
test.describe('home view switch', () => {
  test.afterEach(async ({ page }) => {
    await page.goto('/');
    const mosaic = page.getByTestId('home-view-mosaic');
    if ((await mosaic.getAttribute('aria-checked')) !== 'true') await mosaic.click();
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
  });

  test('switches to the shelves in place, remembers it across a reload, and never asks for the mosaic data', async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    const switcher = page.getByTestId('home-view-switch');
    await expect(switcher).toBeVisible();

    const statsCalls: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/history/stats')) statsCalls.push(r.url());
    });

    await page.getByTestId('home-view-shelves').click();
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    await expect(page.getByTestId('mosaic-home')).toHaveCount(0);
    expect(page.url().replace(/[?#].*$/, '')).toMatch(/\/$/);

    // The choice is on the server, not only in this browser.
    await expect
      .poll(async () => {
        const res = await page.evaluate(async () => {
          const r = await fetch('/api/me/preferences', {
            headers: { Authorization: `Bearer ${localStorage.getItem('nicotind_token')}` },
          });
          return (await r.json()) as { homeView: string | null };
        });
        return res.homeView;
      })
      .toBe('shelves');

    await page.reload();
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    await expect(page.getByTestId('mosaic-home')).toHaveCount(0);
    await expect(page.getByTestId('home-view-shelves')).toHaveAttribute('aria-checked', 'true');
    // `/api/history/stats` feeds only the mosaic's tile sizing.
    expect(statsCalls, 'no mosaic data requested while the shelves are chosen').toEqual([]);
  });

  test('the switch sits in the top-left corner on both views', async ({ page }) => {
    await page.goto('/');
    const box = (await page.getByTestId('home-view-switch').boundingBox())!;
    expect(box.x).toBeLessThan(40);
    expect(box.y).toBeLessThan(120);

    await page.getByTestId('home-view-shelves').click();
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    const shelvesBox = (await page.getByTestId('home-view-switch').boundingBox())!;
    const landing = (await page.getByTestId('radio-landing').boundingBox())!;
    expect(shelvesBox.y, 'above the shelves').toBeLessThan(landing.y + 1);
  });

  // #1770: below md the bar only carries a back target, which neither home view
  // has; the scrolling shelves take the status-bar strip instead.
  test('the shelves home on a phone has no bar, only the status-bar strip', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('app-header')).toBeHidden();
    await expect(page.getByTestId('status-bar-scrim')).toHaveCount(0);
    await page.getByTestId('home-view-shelves').click();
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    await expect(page.getByTestId('app-header')).toBeHidden();
    await expect(page.getByTestId('status-bar-scrim')).toHaveCount(1);
  });

  // #1667: one switch instance, anchored on the header's content edge, so a
  // toggle never moves it (and, being the same node, never drops its focus).
  for (const [width, height] of [
    [768, 1024],
    [1280, 800],
    [1920, 1080],
  ] as const) {
    test(`the switch does not move on toggle at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.goto('/');
      await expect(page.getByTestId('mosaic-home')).toBeVisible();
      const mosaic = await boxOf(page, 'home-view-switch');
      const brand = (await page
        .getByTestId('app-header')
        .getByRole('link', { name: 'NicotinD' })
        .boundingBox())!;
      expect(Math.abs(mosaic.x - brand.x), 'on the header content edge').toBeLessThan(0.5);

      await toShelves(page);
      const shelves = await boxOf(page, 'home-view-switch');
      expect(Math.abs(shelves.x - mosaic.x), 'same x').toBeLessThan(0.5);
      expect(Math.abs(shelves.y - mosaic.y), 'same y').toBeLessThan(0.5);
    });
  }

  test('phone: same x and the same offset inside <main> on both views', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    const main = page.locator('main[data-scroll-root]');
    const mosaic = await boxOf(page, 'home-view-switch');
    const mosaicMain = (await main.boundingBox())!;

    await toShelves(page);
    const shelves = await boxOf(page, 'home-view-switch');
    const shelvesMain = (await main.boundingBox())!;
    expect(Math.abs(mosaic.x - 16)).toBeLessThan(0.5);
    expect(Math.abs(shelves.x - 16)).toBeLessThan(0.5);
    expect(Math.abs(mosaic.y - mosaicMain.y - (shelves.y - shelvesMain.y))).toBeLessThan(0.5);
  });

  for (const width of [375, 1920]) {
    test(`the shelves never start under the switch at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto('/');
      await toShelves(page);
      const sw = await boxOf(page, 'home-view-switch');
      const first = (await page.getByTestId('radio-landing').locator('> *').first().boundingBox())!;
      expect(first.y).toBeGreaterThanOrEqual(sw.y + sw.height - 0.5);
    });
  }

  test('a keyboard toggle keeps focus on the chosen option', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    const shelves = page.getByTestId('home-view-shelves');
    await shelves.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    await expect(shelves).toHaveAttribute('aria-checked', 'true');
    await expect(shelves).toBeFocused();
  });

  test('only the active option shows its label; both keep their names', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('mosaic-home')).toBeVisible();
    const label = (id: string) => page.getByTestId(id).getByTestId('home-view-label');
    await expect(label('home-view-mosaic')).not.toHaveClass(/\bsr-only\b/);
    await expect(label('home-view-shelves')).toHaveClass(/\bsr-only\b/);
    expect((await label('home-view-mosaic').boundingBox())!.width).toBeGreaterThan(1);
    await expect(page.getByRole('radio', { name: 'Mosaic' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Shelves' })).toBeVisible();

    await toShelves(page);
    await expect(label('home-view-shelves')).not.toHaveClass(/\bsr-only\b/);
    await expect(label('home-view-mosaic')).toHaveClass(/\bsr-only\b/);
  });
});
