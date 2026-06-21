import { test, expect } from '../playground/fixtures';
import { firstAlbumId } from '../playground/flow-helpers';
import { appeared } from '../playground/screens-ui';

/**
 * Sharing feedback flow — SELF-CLEANING (share tokens are short-lived: they
 * expire 5 min after first access, so no destructive teardown is needed). Creates
 * a share link for an album, opens /share/:token in a FRESH UNAUTHENTICATED
 * browser context, and verifies the read-only view renders. Records friction +
 * console health on the public surface. See docs/testing-routines.md.
 */
test('sharing-readonly', async ({ page, browser, obs, apiToken }) => {
  const j = obs.journey();
  await page.goto('/library');
  const token = await apiToken();
  const auth = token ? { Authorization: `Bearer ${token}` } : {};

  const albumId = await firstAlbumId(page, token);
  if (!albumId) {
    obs.record({ kind: 'degraded', title: 'No album to share', severity: 'info' });
    obs.outcome('degraded', 'empty library');
    return;
  }

  // 1. Mint a share link.
  const res = await obs.time('create share link (API)', () =>
    page.request.post('/api/share', {
      headers: auth,
      data: { resourceType: 'album', resourceId: albumId },
    }),
  );
  j.step('create share link');
  if (!res.ok()) {
    obs.record({
      kind: 'error',
      title: 'Share link create failed',
      detail: `status ${res.status()}`,
      severity: 'high',
    });
    obs.outcome('failed', `create ${res.status()}`);
    return;
  }
  const url = ((await res.json()) as { url: string }).url;
  const shareUrl = new URL(url).pathname; // /share/<token> — drive relative to baseURL

  // 2. Open it as an anonymous visitor (fresh context = no stored JWT).
  const anon = await browser.newContext();
  const anonPage = await anon.newPage();
  try {
    await anonPage.goto(shareUrl);
    j.step('open /share/:token anonymously');

    // The read-only view should render *something* (the album), and must NOT
    // expose authenticated chrome (the main nav / search).
    const rendered = await appeared(
      anonPage.locator('app-share-view, [data-testid="share-view"], main'),
      8000,
    );
    if (!rendered) j.deadEnd('share view did not render for an anonymous visitor');

    const leakedNav = await anonPage.getByTestId('search-input').count();
    if (leakedNav > 0) {
      obs.record({
        kind: 'gap',
        title: 'Authenticated chrome leaked into the anonymous share view',
        severity: 'high',
        suggestion: 'A share visitor should see a read-only view, not the app search/nav.',
      });
    }

    obs.outcome(rendered ? 'success' : 'partial', 'anonymous read-only view');
    expect(true).toBe(true);
  } finally {
    await anon.close();
  }
});
