import { test, expect } from '../helpers';

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

  test('the header comes back on a phone when the shelves are chosen', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/');
    await expect(page.getByTestId('app-header')).toBeHidden();
    await page.getByTestId('home-view-shelves').click();
    await expect(page.getByTestId('radio-landing')).toBeVisible();
    await expect(page.getByTestId('app-header')).toBeVisible();
  });
});
