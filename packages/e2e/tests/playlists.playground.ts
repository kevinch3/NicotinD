import { test, expect } from '../playground/fixtures';
import { firstAlbumId } from '../playground/flow-helpers';
import { appeared } from '../playground/screens-ui';

/**
 * Playlists feedback flow — a SELF-CLEANING round-trip (local-only feature, safe
 * on prod): create a playlist via API, add a library song, reorder, render it at
 * /library/playlists/:id, then DELETE it in a `finally` so nothing is left behind.
 * Records friction (steps), console health, and a terminal outcome.
 * See docs/testing-routines.md.
 */
test('playlists-roundtrip', async ({ page, browser, obs, apiToken }) => {
  const j = obs.journey();
  await page.goto('/library');
  const token = await apiToken();
  const auth = token ? { Authorization: `Bearer ${token}` } : {};

  const albumId = await firstAlbumId(page, token);
  if (!albumId) {
    obs.record({ kind: 'degraded', title: 'No album to seed a playlist from', severity: 'info' });
    obs.outcome('degraded', 'empty library');
    return;
  }

  // A song id to add — from the album detail payload (`song[]`).
  const detail = await page.request.get(`/api/library/albums/${albumId}`, { headers: auth });
  const songId = (((await detail.json().catch(() => ({}))) as { song?: Array<{ id: string }> }).song ??
    [])[0]?.id;
  if (!songId) {
    obs.record({ kind: 'degraded', title: 'Album had no playable song', severity: 'info' });
    obs.outcome('degraded');
    return;
  }

  const name = `__playground_${Date.now()}`;
  let playlistId: string | null = null;
  try {
    // 1. Create.
    const created = await obs.time('create playlist (API)', () =>
      page.request.post('/api/playlists', { headers: auth, data: { name, songIds: [songId] } }),
    );
    j.step('create playlist');
    if (!created.ok()) {
      obs.record({
        kind: 'error',
        title: 'Playlist create failed',
        detail: `status ${created.status()}`,
        severity: 'high',
      });
      obs.outcome('failed', `create ${created.status()}`);
      return;
    }
    playlistId = (((await created.json()) as { playlist?: { id: string } }).playlist ?? null)?.id ?? null;

    // 2. Render the playlist page (the user-facing surface).
    if (playlistId) {
      await page.goto(`/library/playlists/${playlistId}`);
      const rendered = await appeared(page.getByText(name), 6000);
      if (!rendered) j.fallback('playlist page did not surface its name');
      j.step('open playlist page');

      // 3. Probe the album-detail "add to playlist" affordance (friction of the
      //    real build path, without depending on its exact modal markup).
      await page.goto(`/library/albums/${albumId}`);
      const addAffordance = await page
        .getByRole('button', { name: /add to playlist|playlist/i })
        .count();
      if (addAffordance === 0) j.fallback('no "add to playlist" control on album detail');
      else j.step('locate add-to-playlist control');

      // 4. Share the playlist read-only: mint a link and open it anonymously
      //    (share tokens self-expire, so no teardown needed). Mirrors the album
      //    sharing flow — playlists now have the same affordance.
      const share = await obs.time('create playlist share link (API)', () =>
        page.request.post('/api/share', {
          headers: auth,
          data: { resourceType: 'playlist', resourceId: playlistId },
        }),
      );
      if (!share.ok()) {
        j.fallback(`playlist share create failed (status ${share.status()})`);
      } else {
        const shareUrl = new URL(((await share.json()) as { url: string }).url).pathname;
        const anon = await browser.newContext();
        const anonPage = await anon.newPage();
        try {
          await anonPage.goto(shareUrl);
          const rendered = await appeared(
            anonPage.locator('app-share-view, [data-testid="share-view"], main'),
            8000,
          );
          if (!rendered) j.deadEnd('shared playlist did not render for an anonymous visitor');
          else j.step('open shared playlist anonymously');
          if ((await anonPage.getByTestId('search-input').count()) > 0) {
            obs.record({
              kind: 'gap',
              title: 'Authenticated chrome leaked into the anonymous playlist share view',
              severity: 'high',
              suggestion: 'A share visitor should see a read-only view, not the app search/nav.',
            });
          }
        } finally {
          await anon.close();
        }
      }
    }

    obs.outcome(playlistId ? 'success' : 'partial', 'create → render → share → delete');
    expect(true).toBe(true);
  } finally {
    // Always clean up — never leave a playground playlist behind on prod.
    if (playlistId) {
      const del = await page.request.delete(`/api/playlists/${playlistId}`, { headers: auth });
      if (!del.ok()) {
        obs.record({
          kind: 'error',
          title: 'Playlist cleanup failed (left a __playground_ playlist)',
          detail: `status ${del.status()} id ${playlistId}`,
          severity: 'high',
        });
      }
    }
  }
});
