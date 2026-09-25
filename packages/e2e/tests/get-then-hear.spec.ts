import { test, expect, type Page } from '../helpers';
import { ADMIN, FIXTURE, bearer, openAlbumCard } from '../helpers';
import { E2E_MUSIC_DIR } from '../fixture-music';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import {
  startFixtureAddon,
  FIXTURE_ADDON_TOKEN,
  RICK_ASTLEY_PAYLOAD,
  type FixtureAddon,
  type FixturePayload,
} from './helpers/fixture-addon';

const ADDON_ID = 'fixture-get-then-hear-addon';
/**
 * The rickroll FLAC under a wire path no other spec uses: a result card reads
 * its state off the shared feed by `username:filename`, so reusing the hunt
 * spec's path would render this row "Added" before anything was pressed.
 */
const PAYLOAD: FixturePayload = {
  ...RICK_ASTLEY_PAYLOAD,
  filename: 'Music\\Get Then Hear\\01 Never Gonna Give You Up.flac',
};
const LANDED_TITLE = PAYLOAD.title;
/** Removed on the way out, or every later spec inherits the landed release. */
const LANDED_DIR = join(E2E_MUSIC_DIR, PAYLOAD.artist);

const queueTitles = (page: Page) => page.getByTestId('queue-row-title').allInnerTexts();

/**
 * Get, then hear it (#1294): a single track got from search while something
 * plays becomes the next track by itself once it lands, with one toast. Drives
 * the real loop — search through the fixture addon, Get, the addon finishing,
 * the poller ingesting, the job closing — and asserts only on the job this spec
 * made and the queue of the tab that pressed Get.
 */
test.describe('get, then hear it', () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  let addon: FixtureAddon;
  let auth: Record<string, string>;

  test.beforeAll(async ({ request }) => {
    addon = await startFixtureAddon({ id: ADDON_ID, payload: PAYLOAD });
    const login = await request.post('/api/auth/login', {
      data: { username: ADMIN.username, password: ADMIN.password },
    });
    expect(login.ok()).toBeTruthy();
    auth = bearer(((await login.json()) as { token: string }).token);
    const registered = await request.post('/api/plugins/addons', {
      headers: auth,
      data: { url: addon.url, token: FIXTURE_ADDON_TOKEN },
    });
    expect(registered.status()).toBe(201);
    const enabled = await request.post(`/api/plugins/${ADDON_ID}/enable`, {
      headers: auth,
      data: { consent: true },
    });
    expect(enabled.ok()).toBeTruthy();
  });

  test.afterAll(async ({ request }) => {
    const res = await request.get('/api/downloads/jobs', { headers: auth });
    if (res.ok()) {
      const jobs = (await res.json()) as Array<{
        id: string;
        method: string;
        albumId: string | null;
      }>;
      for (const j of jobs.filter((j) => j.method === ADDON_ID)) {
        if (j.albumId) {
          await request
            .delete(`/api/library/albums/${j.albumId}`, { headers: auth })
            .catch(() => {});
        }
        await request.delete(`/api/downloads/jobs/${j.id}`, { headers: auth }).catch(() => {});
      }
    }
    rmSync(LANDED_DIR, { recursive: true, force: true });
    await request.delete(`/api/plugins/addons/${ADDON_ID}`, { headers: auth });
    await addon.close();
  });

  test('a track got from search while something plays lands as the next track, with one toast', async ({
    page,
    request,
  }) => {
    // Search, a download, an ingest and a scan: more than the 30 s default.
    test.setTimeout(90_000);
    // Something plays: the fixture album, with its own tracks queued behind.
    await page.goto('/library');
    await openAlbumCard(page, FIXTURE.album.title);
    await page.getByTestId('play-album').click();
    await expect(page.getByTestId('player-title')).toBeVisible();
    const playingTitle = await page.getByTestId('player-title').innerText();

    // In-app navigation keeps the player (a goto would reload the SPA).
    await page.getByTestId('desktop-nav').locator('a[href="/get"]').click();
    await page.getByTestId('search-input').fill(LANDED_TITLE);
    await page.getByTestId('search-submit').click();
    const row = page.getByTestId('acquire-result').filter({ hasText: LANDED_TITLE });
    await expect(row).toBeVisible({ timeout: 20_000 });
    await row.getByTestId('acquire-result-get').click();

    // The Get made one job on this addon; finish it addon-side.
    let jobId = '';
    await expect
      .poll(
        async () => {
          const res = await request.get('/api/downloads/jobs', { headers: auth });
          const jobs = (await res.json()) as Array<{ id: string; method: string }>;
          jobId = jobs.find((j) => j.method === ADDON_ID)?.id ?? '';
          return jobId;
        },
        { timeout: 20_000 },
      )
      .not.toBe('');
    await expect.poll(() => addon.jobs.length, { timeout: 20_000 }).toBeGreaterThan(0);
    addon.completeJobs();

    // One toast, naming the landed track, offering "Play now".
    const toast = page.getByTestId('toast').filter({ hasText: LANDED_TITLE });
    await expect(toast).toBeVisible({ timeout: 45_000 });
    await expect(toast).toHaveCount(1);
    await expect(toast.getByTestId('toast-action-0')).toBeVisible();

    // Playback was not interrupted; the landed track is next in the queue.
    await expect(page.getByTestId('player-title')).toHaveText(playingTitle);
    await page.getByTestId('player-title').click();
    await expect(page.getByTestId('now-playing-heading')).toBeVisible();
    await expect.poll(async () => (await queueTitles(page))[0]).toBe(LANDED_TITLE);
    expect((await queueTitles(page)).filter((t) => t === LANDED_TITLE)).toHaveLength(1);

    // "Play now" jumps to it.
    await toast.getByTestId('toast-action-0').click();
    await expect(page.getByTestId('player-title')).toHaveText(LANDED_TITLE);
    await expect(toast).toHaveCount(0);
  });
});
