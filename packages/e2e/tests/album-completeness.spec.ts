import type { APIRequestContext } from '@playwright/test';
import { test, expect } from '../helpers';
import { ADMIN, bearer } from '../helpers';

/**
 * The album page's incomplete badge + curator Complete action (issue #737).
 *
 * The e2e server has no Lidarr, so no hunt ever records a canonical tracklist
 * and no fixture album can be CONFIRMED incomplete for real. The real route is
 * asserted on the one answer it can give here (a complete album → no badge);
 * the incomplete render and the action are driven through a routed response,
 * which is still the contract the unit harness cannot see: the page binding
 * the album id into the nested component, and the toast the click raises.
 */
const completenessPath = /\/api\/library\/albums\/[^/]+\/completeness$/;

async function firstAlbumId(request: APIRequestContext) {
  const login = await request.post('/api/auth/login', {
    data: { username: ADMIN.username, password: ADMIN.password },
  });
  expect(login.ok()).toBeTruthy();
  const token = ((await login.json()) as { token: string }).token;
  const albums = (await (
    await request.get('/api/library/albums', { headers: bearer(token) })
  ).json()) as Array<{ id: string }>;
  expect(albums.length).toBeGreaterThan(0);
  return { id: albums[0]!.id, token };
}

test.describe('album completeness badge', () => {
  test('a fixture album is not confirmed incomplete, and shows no badge', async ({
    page,
    request,
  }) => {
    const { id, token } = await firstAlbumId(request);
    const api = await request.get(`/api/library/albums/${id}/completeness`, {
      headers: bearer(token),
    });
    expect(api.status()).toBe(200);
    expect(await api.json()).toEqual({ albumId: id, confirmed: null });

    const read = page.waitForResponse((r) => completenessPath.test(new URL(r.url()).pathname));
    await page.goto(`/library/albums/${id}`);
    await expect(page.getByTestId('play-album')).toBeVisible();
    expect((await read).ok()).toBe(true);
    await expect(page.getByTestId('album-incomplete-badge')).toHaveCount(0);
    await expect(page.getByTestId('album-complete-action')).toHaveCount(0);
  });

  test('a confirmed-incomplete album shows N of M, and Complete surfaces the outcome', async ({
    page,
    request,
  }) => {
    const { id } = await firstAlbumId(request);
    await page.route(completenessPath, (route) =>
      route.fulfill({
        json: { albumId: id, confirmed: { expected: 12, owned: 9, missing: 3 } },
      }),
    );
    const posts: string[] = [];
    await page.route(`**/api/library/albums/${id}/complete`, (route) => {
      posts.push(route.request().method());
      return route.fulfill({ json: { ok: true, outcome: 'already-complete', lidarrAlbumId: 1 } });
    });

    await page.goto(`/library/albums/${id}`);
    const badge = page.getByTestId('album-incomplete-badge');
    await expect(badge).toHaveText('Incomplete — 9 of 12 tracks');

    // The seeded admin is a curator, on a server with acquisition on.
    const action = page.getByTestId('album-complete-action');
    await expect(action).toBeEnabled();
    await action.click();
    await expect(page.getByTestId('toast').filter({ hasText: 'Nothing to hunt' })).toBeVisible();
    expect(posts).toEqual(['POST']);
  });
});
