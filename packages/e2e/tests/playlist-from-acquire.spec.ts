import { test, expect } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';

/**
 * Playlist-from-acquisition: the link-intent card surfaces a "Treat as playlist"
 * toggle for archive.org URLs (the URL alone doesn't carry a playlist signal),
 * the Downloads row offers an "Open playlist" deep-link when a job has been
 * classified as a playlist, and submitting a URL with `as: 'playlist'` is
 * forwarded to the server. See docs/playlist-from-acquisition.md.
 *
 * The full pipeline (a real spotdl run landing 16 tracks and materializing a
 * playlist) can't run in CI — spotdl needs a YouTube egress + Spotify creds,
 * neither of which the e2e server has. So these tests cover the surface the
 * user actually interacts with (the toggle + the route plumbing), not the
 * post-ingest materialization step (covered by `acquire-watcher.test.ts` +
 * `acquire-playlist.test.ts` at the unit level).
 *
 * Two environment facts these tests must respect (see docs/e2e.md "What the
 * e2e environment does NOT give you"):
 *  - The Playwright `request` fixture is NOT authenticated. storageState only
 *    carries localStorage for `page`; API calls must log in and attach
 *    `bearer(token)` explicitly.
 *  - No resolve-capable plugin is enabled on a fresh e2e server, so the
 *    link-intent card never renders until a test enables one (archive.org
 *    works — it's fetch-based, no binary needed) and disables it again.
 */

/** Log in as the seeded admin over the API and return auth headers. */
async function adminHeaders(
  request: import('@playwright/test').APIRequestContext,
): Promise<Record<string, string>> {
  const res = await request.post('/api/auth/login', {
    data: { username: ADMIN.username, password: ADMIN.password },
  });
  expect(res.ok(), 'admin login should succeed').toBeTruthy();
  const { token } = (await res.json()) as { token: string };
  return bearer(token);
}

test.describe('Playlist-from-acquire (web surface)', () => {
  test.afterEach(async ({ page }) => {
    // Leave archive disabled so the suite stays order-independent (the
    // plugin-gating suite asserts a fresh server enables nothing).
    await page.goto('/settings/plugins');
    const card = page.locator('[data-testid="plugin-card"][data-plugin-id="archive"]');
    if ((await card.getByTestId('plugin-toggle').textContent())?.trim() === 'Disable') {
      await card.getByTestId('plugin-toggle').click();
      await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    }
  });

  test('the link-intent card shows a "Treat as playlist" toggle for archive.org URLs only', async ({
    page,
  }) => {
    // Enable the archive plugin first — without a resolve-capable plugin the
    // link-intent card never renders (plugin capability gating).
    await page.goto('/settings/plugins');
    const card = page.locator('[data-testid="plugin-card"][data-plugin-id="archive"]');
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Enable');
    await card.getByTestId('plugin-toggle').click();
    const consent = page.getByTestId('confirm-ok');
    if (await consent.isVisible().catch(() => false)) await consent.click();
    await expect(card.getByTestId('plugin-toggle')).toHaveText('Disable');

    // An archive.org URL renders the card WITH the playlist toggle.
    await page.goto('/search');
    await page.getByTestId('search-input').fill('https://archive.org/details/foo-123');
    await page.getByTestId('search-input').press('Enter');
    await expect(page.getByTestId('link-intent-card')).toBeVisible();
    await expect(page.getByTestId('link-intent-as-playlist')).toBeVisible();

    // A Spotify playlist URL renders the card WITHOUT the toggle — the URL
    // pattern alone tells the server it's a playlist.
    await page.getByTestId('search-input').fill('https://open.spotify.com/playlist/abc');
    await page.getByTestId('search-input').press('Enter');
    await expect(page.getByTestId('link-intent-card')).toBeVisible();
    await expect(page.getByTestId('link-intent-as-playlist')).toHaveCount(0);
  });

  test('POST /api/acquire accepts the `as` override on an authenticated submit', async ({
    request,
  }) => {
    const headers = await adminHeaders(request);
    const res = await request.post('/api/acquire', {
      headers,
      data: { url: 'https://archive.org/details/test-playlist', as: 'playlist' },
    });
    // No resolve plugin is enabled at this point, so the watcher rejects with
    // NoAcquisitionPluginError (503). A 201 would mean a plugin was left
    // enabled by another test — also fine for this contract. Either proves
    // the route parsed the body (with `as`) and reached the watcher; a 400
    // would mean the body schema rejected `as`.
    expect([201, 503]).toContain(res.status());
  });

  test('the Downloads row offers "Open playlist" only for playlist-classified jobs', async ({
    page,
  }) => {
    // No acquired jobs in the e2e fixture, so the playlist link never renders
    // — assert the testid is absent (the inverse of the playlist-classified
    // path; the positive branch is covered by the web unit tests on
    // `canOpenPlaylist` + the template branching spec).
    await page.goto('/downloads');
    await expect(page.getByTestId('download-open-playlist')).toHaveCount(0);
  });
});

test.describe('Playlist route resolution', () => {
  test('GET /api/playlists responds for an authenticated user', async ({ request }) => {
    const headers = await adminHeaders(request);
    const playlistsRes = await request.get('/api/playlists', { headers });
    expect(playlistsRes.ok()).toBe(true);
    const body = (await playlistsRes.json()) as { playlists: { kind: string }[] };
    expect(Array.isArray(body.playlists)).toBe(true);
  });
});
