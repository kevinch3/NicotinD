import { test, expect } from '@playwright/test';
import { ADMIN, bearer } from '../helpers';

/**
 * Phase 2 — acquisition provenance endpoint. The committed fixtures aren't
 * acquired through the download pipeline, so a fixture song has no `acquisitions`
 * row: the endpoint must return 200 with `null` (graceful "source not recorded")
 * rather than erroring, and 404 for an unknown song.
 */
test.describe('acquisition provenance API', () => {
  test('returns null for an unrecorded song and 404 for an unknown one', async ({ request }) => {
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(login.ok()).toBeTruthy();
    const token = ((await login.json()) as { token: string }).token;

    // Grab a real song id from the first album.
    const albums = (await (
      await request.get('/api/library/albums', { headers: bearer(token) })
    ).json()) as Array<{ id: string }>;
    expect(albums.length).toBeGreaterThan(0);
    const album = (await (
      await request.get(`/api/library/albums/${albums[0]!.id}`, { headers: bearer(token) })
    ).json()) as { song: Array<{ id: string }> };
    const songId = album.song[0]!.id;

    const acq = await request.get(`/api/library/songs/${songId}/acquisition`, {
      headers: bearer(token),
    });
    expect(acq.status()).toBe(200);
    expect(await acq.json()).toBeNull();

    const missing = await request.get('/api/library/songs/does-not-exist/acquisition', {
      headers: bearer(token),
    });
    expect(missing.status()).toBe(404);
  });
});
