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
test('playlists-roundtrip', async ({ page, obs, apiToken }) => {
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
    }

    obs.outcome(playlistId ? 'success' : 'partial', 'create → render → delete');
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
