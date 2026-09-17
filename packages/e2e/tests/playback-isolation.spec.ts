import { test, expect, type APIRequestContext, type Page } from '../helpers';
import { FIXTURE, bearer, openAlbumCard } from '../helpers';

/**
 * The isolation guarantee behind `freshPlaybackSession` (helpers.ts): a spec
 * that plays and is then torn down — no `page.close()`, so no `pagehide`,
 * exactly what Playwright does between tests — leaves its session on the
 * server, and the spec after it must still start from an empty one. Read
 * through `GET /api/playback/session` rather than the player bar, because an
 * absent track in a bar that may not have rendered proves nothing
 * (docs/e2e.md "An absence assertion passes vacuously").
 */
type Session = { activeDeviceId: string | null; isPlaying: boolean; trackId: string | null };

async function session(request: APIRequestContext, token: string): Promise<Session> {
  const res = await request.get('/api/playback/session', { headers: bearer(token) });
  expect(res.ok()).toBeTruthy();
  return (await res.json()) as Session;
}

function tokenOf(page: Page): Promise<string> {
  return page.evaluate(() => localStorage.getItem('nicotind_token') ?? '');
}

test.describe('per-spec playback session isolation', () => {
  test.describe.configure({ mode: 'serial' });

  test('a spec that plays leaves its session behind when its context is torn down', async ({
    page,
    request,
  }) => {
    await page.goto('/library');
    const token = await tokenOf(page);
    expect(token).toBeTruthy();

    await openAlbumCard(page, FIXTURE.album.title);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title').first()).not.toHaveText('');

    // The server has the track: this is the state the next spec would inherit.
    await expect
      .poll(async () => (await session(request, token)).trackId, { timeout: 10_000 })
      .not.toBeNull();
    // Deliberately no page.close(): the teardown fires no pagehide.
  });

  test('the spec after it starts from an empty session', async ({ page, request }) => {
    await page.goto('/settings');
    await expect(page.getByTestId('desktop-nav')).toBeVisible();
    const token = await tokenOf(page);

    expect(await session(request, token)).toMatchObject({
      activeDeviceId: null,
      isPlaying: false,
      trackId: null,
    });
  });
});
