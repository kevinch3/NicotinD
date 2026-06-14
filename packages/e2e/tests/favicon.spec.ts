import { test, expect } from '@playwright/test';

test.describe('favicon', () => {
  // Guards against a broken/stale favicon link after the brand-icon rework.
  test('brand favicons are served and linked from the document head', async ({ page, request }) => {
    for (const path of ['/favicon.ico', '/icons/icon.svg', '/icons/icon-32.png']) {
      const res = await request.get(path);
      expect(res.status(), `${path} should resolve`).toBe(200);
    }

    await page.goto('/');
    await expect(page.locator('link[rel="icon"][type="image/svg+xml"]')).toHaveAttribute(
      'href',
      '/icons/icon.svg',
    );
  });
});
