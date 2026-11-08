import type { APIRequestContext, Page } from '@playwright/test';
import { test, expect } from '../helpers';
import { ADMIN, FIXTURE, bearer, openAlbumCard } from '../helpers';

/**
 * #1726: a failed stream must never leave the PREVIOUS track audible under the
 * new track's title, and must not leave the new one stuck. In a self-hoster
 * trial, playing a just-downloaded track while a 30 s one played got a 503 on
 * its first stream request; the bar switched to the new title, but the audio
 * did not follow.
 *
 * The failing request is the standby pre-load: a track under 30 s pre-buffers
 * the next one at once. Nothing listens on the standby, so the player used to
 * swap to the dead element on the click and sit "buffering" for good.
 *
 * The 503 is injected at the network layer so the browser's own media pipeline
 * raises the error, as it did on the trial host.
 */
async function fixtureSongIds(request: APIRequestContext): Promise<string[]> {
  const login = await request.post('/api/auth/login', {
    data: { username: ADMIN.username, password: ADMIN.password },
  });
  const { token } = (await login.json()) as { token: string };
  const albums = (await (
    await request.get('/api/library/albums', { headers: bearer(token) })
  ).json()) as Array<{ id: string; name: string }>;
  const album = albums.find((a) => a.name === FIXTURE.album.title)!;
  const detail = (await (
    await request.get(`/api/library/albums/${album.id}`, { headers: bearer(token) })
  ).json()) as { song: Array<{ id: string }> };
  return detail.song.map((s) => s.id);
}

/** Ids of the <audio> elements that are currently producing sound. */
function audibleIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('audio'))
      .filter((a) => !a.paused)
      .map((a) => new URL(a.src).pathname.split('/').pop()!),
  );
}

test.describe('a stream error on a track change', () => {
  test('never keeps the previous track audible, and recovers the new one', async ({
    page,
    request,
  }) => {
    const [first, second] = await fixtureSongIds(request);
    let failed = 0;
    await page.route(`**/api/stream/${second}**`, async (route) => {
      if (failed === 0) {
        failed++;
        await route.fulfill({ status: 503, body: '' });
        return;
      }
      await route.continue();
    });

    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    const rows = page.getByTestId('track-row');
    await rows.nth(0).getByTestId('track-row-title').click();
    await expect.poll(() => audibleIds(page), { timeout: 15_000 }).toEqual([first]);
    // Track 1 is under 30 s long, so the player pre-buffers track 2 into the
    // standby element straight away; that is the request that gets the 503.
    await expect.poll(() => failed, { timeout: 15_000 }).toBe(1);

    await rows.nth(1).getByTestId('track-row-title').click();

    // From the moment track 2 is current, track 1 must be silent. Sampled
    // across the load and the 1 s media-error retry window.
    const deadline = Date.now() + 4_000;
    while (Date.now() < deadline) {
      expect(await audibleIds(page), 'track 1 is still audible after switching').not.toContain(
        first,
      );
      await page.waitForTimeout(100);
    }
    // A fresh load on the active element recovers: track 2 ends up playing.
    await expect.poll(() => audibleIds(page), { timeout: 15_000 }).toEqual([second]);
    await expect(rows.nth(1)).toHaveAttribute('data-playback-state', 'playing');
  });
});
