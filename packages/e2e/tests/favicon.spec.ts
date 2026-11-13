import { test, expect } from '../helpers';

test.describe('favicon', () => {
  // Guards against a broken/stale favicon link after the brand-icon rework.
  test('brand favicons are served and linked from the document head', async ({ page, request }) => {
    for (const path of ['/favicon.ico', '/icons/icon.svg', '/icons/icon-32.png']) {
      const res = await request.get(path);
      expect(res.status(), `${path} should resolve`).toBe(200);
    }

    // The href is base-relative (the static demo serves the bundle under a
    // sub-path, docs/demo-mode.md), so assert where it resolves, not its text.
    await page.goto('/');
    const link = page.locator('link[rel="icon"][type="image/svg+xml"]');
    expect(new URL(await link.evaluate((el) => (el as HTMLLinkElement).href)).pathname).toBe(
      '/icons/icon.svg',
    );
  });
});
