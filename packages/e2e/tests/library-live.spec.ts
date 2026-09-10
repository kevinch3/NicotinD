import { test, expect } from '@playwright/test';
import { copyFileSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADMIN, bearer, scanAndWait, waitForLibrary } from '../helpers';

const HERE = dirname(fileURLToPath(import.meta.url));
/** A throwaway one-track album this spec alone owns. Album identity comes from
 *  the TAGS, not the folder: `live-probe.flac` is tagged "Live Probe Artist /
 *  Live Probe Album / Live Probe Song", so no other spec can add a track to it
 *  (the old plant copied `addon-song.flac` into the shared "Addon Album", #1064). */
const PLANT_DIR = join(HERE, '../fixtures/music/Live Probe Artist');
const PLANTED = join(PLANT_DIR, 'Live Probe Album', '01 - Live Probe Song.flac');
const SOURCE = join(HERE, '../fixtures/plant/live-probe.flac');
const PLANT_ALBUM = 'Live Probe Album';

/**
 * Live library changes reach an open page over `/api/library/events`
 * (docs/cache-invalidation.md "Live invalidation"): a song deleted through the
 * API — the way an MCP curator or another device would — leaves the album page
 * that is already open, with no reload.
 *
 * The victim is a planted copy, never a git-tracked fixture file: deleting a
 * real fixture leaves the checkout short a file for every later run.
 */
test.describe('live library updates', () => {
  test.afterAll(async ({ request }) => {
    rmSync(PLANT_DIR, { recursive: true, force: true });
    // Prune the planted row (its file is gone) so later specs see the fixture album as shipped.
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    if (login.ok()) {
      const { token } = (await login.json()) as { token: string };
      await scanAndWait(request, token).catch(() => {});
    }
  });

  test('a song deleted through the API disappears from the open album page without a reload', async ({
    page,
    request,
  }) => {
    await page.goto('/library');
    const token = await page.evaluate(() => localStorage.getItem('nicotind_token'));
    expect(token).toBeTruthy();
    const auth = bearer(token!);

    // The events endpoint must exist on the target server. A stream never
    // ends, so probe from the page: fetch() resolves on headers, then abort.
    const status = await page.evaluate(async (t) => {
      const ctl = new AbortController();
      try {
        const r = await fetch(`/api/library/events?since=999999&token=${t}`, {
          signal: ctl.signal,
        });
        ctl.abort();
        return r.status;
      } catch {
        return 0;
      }
    }, token);
    test.skip(status === 404, 'server has no /api/library/events');
    expect(status).toBe(200);

    await waitForLibrary(request, token!);
    if (!existsSync(PLANTED)) {
      mkdirSync(dirname(PLANTED), { recursive: true });
      copyFileSync(SOURCE, PLANTED);
    }
    await scanAndWait(request, token!);

    // Resolve the planted album through the API (the grid may file it as a single).
    const search = await request.get(
      '/api/library/songs?size=200&q=' + encodeURIComponent(PLANT_ALBUM),
      {
        headers: auth,
      },
    );
    expect(search.ok()).toBeTruthy();
    const found = (
      (await search.json()) as Array<{ id: string; albumId?: string; album?: string }>
    ).find((s) => s.album === PLANT_ALBUM && s.albumId);
    expect(found?.albumId).toBeTruthy();
    const albumId = found!.albumId!;
    const victim = found!;

    const opened: string[] = [];
    page.on('request', (r) => {
      if (r.url().includes('/api/library/events')) opened.push(r.url());
    });
    await page.goto(`/library/albums/${albumId}`);
    await expect(page.getByTestId('play-album')).toBeVisible();
    const rows = page.getByTestId('track-row');
    await expect(rows).toHaveCount(1);

    await expect
      .poll(() => opened.length, {
        timeout: 5_000,
        message: 'the page never opened the events stream',
      })
      .toBeGreaterThan(0);
    const del = await request.delete(`/api/library/songs/${victim.id}`, { headers: auth });
    expect(del.ok()).toBeTruthy();

    // No reload, no navigation: the page learns from the stream that its only
    // track is gone, refetches, and shows the album as no longer there.
    await expect(rows).toHaveCount(0, { timeout: 10_000 });
    await expect(page.getByTestId('album-not-found')).toBeVisible();
  });
});
